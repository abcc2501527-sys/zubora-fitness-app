import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { installNotificationHandler } from '@/lib/reminders';
import { supabase } from '@/supabase';

// 通知ハンドラの初期化は lib/reminders.ts の installNotificationHandler() に一本化
// （ここで別の（旧APIの）ハンドラを登録すると、フォアグラウンド表示の設定が上書きされて壊れる）
installNotificationHandler();

/**
 * 端末の Push トークンを取得して Supabase に保存。
 * EAS の projectId が未設定（eas.json 未作成 / app.json に extra.eas.projectId が無い）だと
 * getExpoPushTokenAsync() が失敗するため、その場合は null を返すだけにする
 * （リマインドはローカル通知（lib/reminders.ts）で別途動くので、ここが失敗しても支障ない）。
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) {
    console.log('Web環境またはシミュレーターのため、プッシュ通知登録をスキップします');
    return null;
  }

  try {
    // Android用の通知チャンネル設定
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('通知権限が拒否されました');
      return null;
    }

    // Expo Push Token 取得（EAS projectId が無いとここで例外になる）
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;

    // ログイン中のユーザーの push_token を更新
    const { data: auth } = await supabase.auth.getUser();
    if (auth.user) {
      await supabase.from('users').update({ push_token: token }).eq('id', auth.user.id);
    }

    return token;
  } catch (e) {
    console.warn('[notificationService] Push トークンの取得に失敗しました（EAS 未設定など）', e);
    return null;
  }
}

/** 相手の Push Token 宛に Expo Push API 経由で通知を送信 */
export async function sendPushNotification(
  targetPushToken: string,
  title: string,
  body: string,
) {
  if (!targetPushToken) return;
  // WebブラウザからだとCORSでブロックされてFailed to fetchになるだけで、
  // そもそもWebではpush_token自体を登録していない（上のregisterForPushNotificationsAsync参照）
  if (Platform.OS === 'web') return;

  const message = {
    to: targetPushToken,
    sound: 'default',
    title,
    body,
    data: { someData: 'goes here' },
  };

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
}