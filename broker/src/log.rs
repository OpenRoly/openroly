//! log 1 行に **時刻**を付ける(PBI-0277)。
//!
//! `launchd` の `StandardErrorPath` は行に時刻を付けない。時刻の無い log は
//! 「**いつ黙ったか**」に答えられず、「process は生きているのに繋がらない」の切り分けが
//! file の mtime(= 最後の 1 行の時刻)だけになる —— 実際 2026-09-05 の調査はそこで止まった。
//!
//! 依存は増やさない(`chrono` / `time` を入れない)。要るのは UTC の 1 行だけなので、
//! 日付の計算は civil_from_days(Howard Hinnant)を 10 行で持つ。

use std::time::{SystemTime, UNIX_EPOCH};

/// `2026-09-05T19:26:03Z` 形式の UTC。時計が UNIX_EPOCH より前(= 設定不良)なら 0 秒として扱う。
pub fn now_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_utc(secs)
}

/// epoch 秒 → ISO 8601(UTC)。**純関数**なので既知の epoch で検査できる。
pub fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil_from_days: 1970-01-01 を day 0 とする暦計算(閏年 / 400 年周期を含む)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// `eprintln!` の代わり。**時刻 + `broker:` の接頭辞**を 1 箇所で決める。
#[macro_export]
macro_rules! blog {
    ($($arg:tt)*) => {
        eprintln!("{} broker: {}", $crate::log::now_utc(), format_args!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::format_utc;

    /// 既知の epoch 3 点(閏年 2 月末 / 世紀の非閏年 / 日付境界)で暦計算を固定する。
    #[test]
    fn 既知の_epoch_を_utc_に直せる() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        // 2000-02-29(400 年周期の閏年)
        assert_eq!(format_utc(951_782_400), "2000-02-29T00:00:00Z");
        // 1900-03-01 は epoch より前なので、代わりに 2100 側の非閏年を跨ぐ日を見る
        assert_eq!(format_utc(4_107_542_399), "2100-02-28T23:59:59Z");
        assert_eq!(format_utc(4_107_542_400), "2100-03-01T00:00:00Z");
    }
}
