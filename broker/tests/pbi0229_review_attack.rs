//! PBI-0229 の有界レビュー(攻撃)。newway §14.1。
//!
//! 本体の unit(sessions.rs tests)が測っていない面を撃つ:
//!   1. **hello_snapshot の dead 行 remove が reaper から `session_result` を奪う**
//!      —— 子が死んでから reaper(250ms)が掃くまでの窓で hello(再接続・rescan 差分)か
//!      CLI status が来ると、行は registry から消えて reaper は二度と拾えない。
//!      session_result が失われ、server 側は `owner_session_end` も `session_interrupted`
//!      (AC-B8-2)も書けない。`admission_check` のコメント(「掃くのは reaper だけ」)と
//!      同一 file 内で矛盾している
//!   2. **capacity.used が manual session を数える** —— admission 免除の物を枠に数えるので
//!      web の「No capacity right now」が嘘を出す(manual だけで満杯表示・実際は auto が取れる)
//!   3. `status_alive_scoped` の床は本体の unit で撃たれているので再撃しない
//!
//! attack 1・2 は **fix 前の tree で赤く始まる**(破れの実測)。fix を外せば赤に戻る =
//! 負の対照を兼ねる(armed-tests §2)。

#[path = "../src/c1.rs"]
mod c1;
#[path = "../src/egress.rs"]
mod egress;
#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/sessions.rs"]
mod sessions;
// PBI-0403 有界レビューで実測: sessions.rs の test が `crate::launch::launch_with_scope` を
// 参照するようになった —— launch.rs とその依存(env_compat / registry / discovery /
// openroly_cli / sandbox)も一緒に取り込まないとこのバイナリはコンパイルできない(E0433)。
#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/registry.rs"]
mod registry;
#[path = "../src/discovery.rs"]
mod discovery;
#[path = "../src/openroly_cli.rs"]
mod openroly_cli;
#[path = "../src/sandbox.rs"]
mod sandbox;
#[path = "../src/launch.rs"]
mod launch;

use serde_json::{json, Value};
use tokio::process::{Child, Command};

use sessions::{Session, Sessions};

async fn sleep_child(secs: &str) -> Child {
    Command::new("sleep").arg(secs).kill_on_drop(true).spawn().unwrap()
}

fn session_row(rid: &str, lane: &str, child: Child) -> Session {
    Session {
        request_id: rid.to_string(),
        lane: lane.to_string(),
        account_id: "acc-1".to_string(),
        thread_id: String::new(),
        runtime: "claude".to_string(),
        started_at: 0,
        child: Some(child),
        egress: None,
        last_tool: None,
        tool_count: 0,
        exit: None,
        cancel_reason: None,
    }
}

/// 攻撃 1(AC-B8-2 の race・破れ 1): 子が死んだ直後に hello / CLI status が来ると
/// hello_snapshot が行を消し、reaper は `session_result` を永久に運べない。
/// 正しい挙動: snapshot から死んだ行を **出さない** だけで、registry からは消さない
/// (掃くのは reaper だけ —— admission_check のコメントと同じ規則)。
#[tokio::test]
async fn hello_snapshot_must_not_steal_session_result_from_reaper() {
    let mut c1 = Command::new("sleep").arg("0").kill_on_drop(true).spawn().unwrap();
    let _ = c1.wait().await; // 子はもう死んでいる(reaper はまだ呼んでいない)
    let sessions = Sessions::new(None);
    sessions.insert(session_row("rid-dead", "auto", c1));

    // 再接続の hello(または CLI の status)がこの窓で来る
    let (list, _) = sessions.hello_snapshot(4);
    assert!(
        list.as_array().unwrap().is_empty(),
        "死んだ行は snapshot に出ない(表示の嘘を消すのは正しい)"
    );

    // それでも掃くのは reaper だけ —— session_result が失われない事
    let frame: Value = sessions
        .reap_once()
        .expect("hello を通った後でも reaper は session_result を運ぶ");
    assert_eq!(frame["requestId"], json!("rid-dead"));
    assert_eq!(frame["exit_code"], json!(0));
    assert!(frame["reason"].is_null());
    // 運ばれた後は空(1 行 1 回)
    assert!(sessions.reap_once().is_none());
}

/// 攻撃 2(AC-A5-2 の表示の嘘・破れ 2): manual は admission 免除 = 枠の意味が無いのに
/// used に数えられる。manual だけで used==max になり、web は「No capacity right now」を
/// 出すが、実際は auto が取れる(表示と矛盾)。used は admission 対象の lane だけを数えるべき。
#[tokio::test]
async fn capacity_used_counts_only_admission_lanes() {
    let sessions = Sessions::new(None);
    for i in 0..4 {
        let c = sleep_child("30").await;
        sessions.insert(session_row(&format!("rid-man{i}"), "manual", c));
    }
    let (list, cap) = sessions.hello_snapshot(4);
    assert_eq!(list.as_array().unwrap().len(), 4, "manual の行自体は presence の正本として見える");
    assert_eq!(
        cap["used"],
        json!(0),
        "manual は admission 免除 = capacity.used を膨らませない(満杯表示の嘘を消す)"
    );
    // 表示と矛盾しない: 実際に auto は取れる
    assert_eq!(sessions.admission_check("acc-1", "auto"), None);
    // 対照: admission 対象の lane は数える
    let c = sleep_child("30").await;
    sessions.insert(session_row("rid-auto", "owner", c));
    let (_, cap) = sessions.hello_snapshot(4);
    assert_eq!(cap["used"], json!(1));
}
