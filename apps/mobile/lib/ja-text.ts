/**
 * 日本語の文章を、文節の途中で折り返されにくくする。
 * 日本語は文字ごとに折り返し可能なので、「ステップ／アップ」「運／動」のように
 * 単語の途中で1文字だけ次の行に落ちてしまう。BudouX で文節に分け、
 * 文節の内側の文字どうしを WORD JOINER(U+2060) でつないで折り返しを禁止する
 * （文節の境目では従来どおり折り返せる）。
 */
import { loadDefaultJapaneseParser } from 'budoux';
import { Platform } from 'react-native';

const WORD_JOINER = '⁠';
const EMOJI_OR_JOINER = /[☀-➿\u{1F000}-\u{1FFFF}‍️]/u;

// Android では U+2060 が豆腐(□)で出る端末があるため、iOS のみ適用する
const parser = Platform.OS === 'ios' ? loadDefaultJapaneseParser() : null;

export function softWrapJa(text: string): string {
  if (!parser || !text) return text;
  return text
    .split('\n')
    .map((line) =>
      parser
        .parse(line)
        .map((phrase) => (EMOJI_OR_JOINER.test(phrase) ? phrase : Array.from(phrase).join(WORD_JOINER)))
        .join(''),
    )
    .join('\n');
}
