//! Session registry(PBI-0229)。broker を「いま動いている session」の唯一の正本にする。
//!
//! - `Sessions` は request_id → `Session` の map。子 process の handle(`Child`)を **保持する** ので、
//!   生存判定は `child.try_wait()`(pid ではなく handle)。pid の再利用で嘘をつかない。
//! - **admission は broker が判定**: 同じ `(account_id, lane)` の session が生きていれば 2 本目を
//!   断る(`admission_check` → wake_result `session_active`)。`manual` lane だけ対象外
//!   (人が画面の前で操作している = 直列化の意味が無い)。
//! - `cancel`: SIGTERM → 5 秒 → SIGKILL を **process group ごと**(PBI-0403)。子は spawn 時に
//!   group leader にしてある(`launch_in` の `process_group(0)`)ので、その下の tool 実行 /
//!   MCP server / node まで届く —— 直の子だけに送っていた頃は孫が孤児で生き残るのに
//!   `session_result` が「終わった」と報告していた。reaper が `session_result{exit_code, reason}` を送る。
//!   理由は `cancel_reason` に載る("cancelled" = 人の stop / "tool_cap" = 上限到達)。
//! - tool 呼び出しは hook socket 経由の `tool_call` で数える(本文は見ない。名前と件数だけ)。
//!   `OPENROLY_SESSION_TOOL_CAP` が在れば到達で kill する(値は owner が決める。既定 = 無制限)。
//! - 状態は 4 値(idle / starting / running / stopping)。idle だけ「registry が空」を意味する。
//!
//! 接続を跨いで registry は main 所有で生存する(切断しても session は動き続ける)ので、
//! 再接続直後の hello が snapshot を載せ、server 側の cache がそこから reconcile される。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Child;
use tokio::sync::mpsc::UnboundedSender;

use crate::procgroup::kill_group;

/// cancel の SIGTERM → SIGKILL の猶予。sleep のような TERM を無視しない子はここで死ぬ。
pub const CANCEL_ESCALATE_MS: u64 = 5_000;
/// reaper の生存確認間隔。`try_wait` は block しないので短くてよい。
const REAP_POLL_MS: u64 = 250;

/// registry の 1 行。`child` は reaper が `try_wait` する対象(所有は registry)。
pub struct Session {
    pub request_id: String,
    pub lane: String,
    pub account_id: String,
    pub thread_id: String,
    pub runtime: String,
    /// unix ms。hello snapshot / elapsed の根拠
    pub started_at: u64,
    pub child: Option<Child>,
    /// dedicated session の egress proxy(child と同じ寿命)。reap で行ごと drop = 閉じる(PBI-0238)。
    /// C1 の session なら `egress.c1` が pool の uid を持ち、cancel はその uid として signal を打つ(PBI-0441)
    pub egress: Option<crate::egress::Egress>,
    pub last_tool: Option<String>,
    pub tool_count: u32,
    pub exit: Option<i32>,
    /// cancel 済み(stopping 状態)。reaper の session_result に `reason` として載る
    pub cancel_reason: Option<String>,
}

impl Session {
    fn alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

struct Inner {
    sessions: HashMap<String, Session>,
    /// `OPENROLY_SESSION_TOOL_CAP`。None = 無制限(owner が値を決める前の既定)
    tool_cap: Option<u32>,
}

/// 行 1 つが capacity.used を消費するか(lane が admission 対象で、child の handle が生きて
/// いる)。「死んでいる」の定義は hello_snapshot が list から外す判定と同じ式。
fn consumes_capacity(s: &mut Session) -> bool {
    s.lane != "manual" && !(s.child.is_some() && !s.alive())
}

impl Inner {
    /// admission 対象の lane の **生きている** 行数(= hello の `capacity.used`)。
    /// hello_snapshot(表示)と capacity_full(wake の門・PBI-0391)の **両方**がこの 1 つを数える
    /// —— 数え方が 2 つ在る事自体が 0229 review の破れ(used==max の表示なのに 5 本目を
    /// spawn する)だった。「生きている」の判定は admission_check と同じ handle の try_wait。
    fn admission_used(&mut self) -> usize {
        let mut used = 0;
        for s in self.sessions.values_mut() {
            if consumes_capacity(s) {
                used += 1;
            }
        }
        used
    }
}

/// Arc<Mutex<...>> の薄い wrapper。main / hook socket / reaper / wake 経路で共有する。
#[derive(Clone)]
pub struct Sessions(Arc<Mutex<Inner>>);

impl Sessions {
    pub fn new(tool_cap: Option<u32>) -> Self {
        Self(Arc::new(Mutex::new(Inner { sessions: HashMap::new(), tool_cap })))
    }

    /// **spawn 前の admission**(AC-X3)。同じ `(account_id, lane)` の **生きている** session が
    /// 在ればその request_id を返す(manual は常に None = 通す)。「生きている」は
    /// `try_wait`(handle)で見る —— pid ではない。exit 済みの行はここでは消さない
    /// (消すと reaper の session_result が失われる。掃くのは reaper だけ)。
    /// lane "work"(PBI-0439)も None —— work ごとに別 session が並ぶ lane で、account あたりの本数は
    /// server が持つ(WORK_LANE_MAX_SESSIONS)。端末全体の上限は capacity_full が今まで通り数える。
    pub fn admission_check(&self, account_id: &str, lane: &str) -> Option<String> {
        if lane == "manual" || lane == "work" {
            return None;
        }
        let mut inner = self.0.lock().unwrap();
        let mut live: Vec<String> = Vec::new();
        for s in inner.sessions.values_mut() {
            if s.account_id == account_id && s.lane == lane && s.alive() {
                live.push(s.request_id.clone());
            }
        }
        live.into_iter().next()
    }

    /// spawn 成功後に 1 行 insert(manual も載せる = presence の正本はここ)。
    pub fn insert(&self, session: Session) {
        self.0.lock().unwrap().sessions.insert(session.request_id.clone(), session);
    }

    /// hook socket の `{"type":"tool","session":id,"tool":name}`。更新後の session_update frame を
    /// 返す(session が無ければ None = 手動 session や終了済み)。tool cap に当たったら
    /// `"capped":true` を載せる —— kill は呼び手(handle_hook_json)が起こす。
    pub fn tool_call(&self, session_id: &str, tool: &str, now_ms: u64) -> Option<Value> {
        let mut inner = self.0.lock().unwrap();
        let cap = inner.tool_cap;
        let s = inner.sessions.get_mut(session_id)?;
        s.last_tool = Some(tool.to_string());
        s.tool_count += 1;
        let capped = s.tool_count >= cap.unwrap_or(u32::MAX);
        Some(json!({
            "type": "session_update",
            "requestId": s.request_id,
            "last_tool": s.last_tool,
            "tool_count": s.tool_count,
            "updated_at": now_ms,
            "capped": capped,
        }))
    }

    /// tool 上限に当たった時の kill(A6-2)。tool_call が capped を返したら呼ぶ。
    pub fn cancel_tool_capped(&self, request_id: &str) {
        self.cancel_with_escalate(request_id, "tool_cap", Duration::from_millis(CANCEL_ESCALATE_MS));
    }

    /// server からの `{"type":"cancel","requestId"}`(AC-3 / A6-1)。SIGTERM → 猶予後に SIGKILL。
    pub fn cancel(&self, request_id: &str, reason: &str) -> bool {
        self.cancel_with_escalate(request_id, reason, Duration::from_millis(CANCEL_ESCALATE_MS))
    }

    /// request_id が `account_id` の持ち物の時だけ受理する cancel(server 経路用)。broker は
    /// 1 接続で複数 account を serve しうるので、WS の cancel は request_id だけで引くと
    /// 別 account の request_id を知った接続が他人の session を止められる(AC-X1 の broker 側の床)。
    pub fn cancel_scoped(&self, request_id: &str, account_id: &str, reason: &str) -> bool {
        if !self.owned_by(request_id, account_id) {
            return false;
        }
        self.cancel(request_id, reason)
    }

    /// `status_alive` の account 付き。registry に無い / 他人の request はどちらも false。
    pub fn status_alive_scoped(&self, request_id: &str, account_id: &str) -> bool {
        if !self.owned_by(request_id, account_id) {
            return false;
        }
        self.status_alive(request_id)
    }

    fn owned_by(&self, request_id: &str, account_id: &str) -> bool {
        let inner = self.0.lock().unwrap();
        inner
            .sessions
            .get(request_id)
            .map(|s| s.account_id == account_id)
            .unwrap_or(false)
    }

    pub fn cancel_with_escalate(&self, request_id: &str, reason: &str, escalate: Duration) -> bool {
        let pid = {
            let mut inner = self.0.lock().unwrap();
            let Some(s) = inner.sessions.get_mut(request_id) else { return false };
            if s.cancel_reason.is_some() {
                return true; // 2 度目以降は何もしない(既に stopping)
            }
            s.cancel_reason = Some(reason.to_string());
            s.child.as_mut().and_then(|c| c.id())
        };
        // C1(PBI-0441 ③)の session は root の sudo + pool の uid の下で走り、broker の killpg は
        // どちらにも届かない(kill(2) の uid 一致)。**pool の uid として**同じ signal を打つ
        let pool_user = {
            let inner = self.0.lock().unwrap();
            inner
                .sessions
                .get(request_id)
                .and_then(|s| s.egress.as_ref())
                .and_then(|e| e.c1.as_ref())
                .map(|c| c.user.clone())
        };
        let Some(pid) = pid else { return true };
        // **SIGTERM が 1 発目**。送り先は直の子ではなく **process group**(PBI-0403)。
        kill_group(pid, libc::SIGTERM);
        if let Some(user) = &pool_user {
            crate::c1::signal_pool(user, "TERM");
        }
        let sessions = self.0.clone();
        let rid = request_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(escalate).await;
            let mut inner = sessions.lock().unwrap();
            if let Some(s) = inner.sessions.get_mut(&rid) {
                if let Some(c) = s.child.as_mut() {
                    if matches!(c.try_wait(), Ok(None)) {
                        // **group ごと SIGKILL**。TERM を無視する子と、その下の孫は
                        // ここでしか死なない。pid は `try_wait` の **後に取り直す** ——
                        // 回収済みの handle は `id()` が None を返すので、再利用された
                        // pid の「他人の group」へ送らない(AC-X2)
                        if let Some(pid) = c.id() {
                            kill_group(pid, libc::SIGKILL);
                        }
                        if let Some(user) = &pool_user {
                            crate::c1::signal_pool(user, "KILL");
                        }
                        // 直の子の handle にも撃つ(tokio に「殺した」を知らせて try_wait で
                        // 回収させる。group へ既に届いているので二重でも害は無い)
                        let _ = c.start_kill();
                    }
                }
            }
        });
        true
    }

    /// `{"type":"status","requestId"}` への答え。registry に載って生きている時だけ true。
    pub fn status_alive(&self, request_id: &str) -> bool {
        let mut inner = self.0.lock().unwrap();
        match inner.sessions.get_mut(request_id) {
            Some(s) => s.alive(),
            None => false,
        }
    }

    /// exit を観測した行を掃除し、`session_result` frame を返す(reaper が 250ms 間隔で呼ぶ)。
    /// remove した行は drop し、egress proxy もここで閉じる(child と同じ寿命)。
    pub fn reap_once(&self) -> Option<Value> {
        let mut inner = self.0.lock().unwrap();
        let rid = inner.sessions.values_mut().find_map(|s| {
            if s.child.is_none() {
                return None;
            }
            match s.child.as_mut().unwrap().try_wait() {
                Ok(Some(status)) => {
                    // signal 終了は code() が None → JSON null(旧 per-child reaper と同じ形)
                    s.exit = status.code();
                    Some(s.request_id.clone())
                }
                Ok(None) => None,
                Err(_) => Some(s.request_id.clone()),
            }
        })?;
        let s = inner.sessions.remove(&rid)?;
        let reason = s.cancel_reason.clone();
        Some(json!({
            "type": "session_result",
            "requestId": s.request_id,
            "exit_code": s.exit,
            "reason": reason,
        }))
    }

    /// **spawn 前の同時実行上限**(PBI-0391 / AC-1)。admission((account, lane) の重複)とは別の門で、
    /// 端末全体の session 本数を `capacity.used`(hello_snapshot の表示)と **同じ数え方**
    /// (admission_used)で数え、上限に達していれば true(= wake を断る・spawn しない)。
    /// manual は免除(admission と同じ扱い —— used にも数えていないので、門だけで断つと
    /// 表示と実際が逆に矛盾する)。上限は **件数ではなく同時実行数**: 行が死んで reaper に
    /// 掃われれば枠はすぐ戻る(PBI-0235 の決定と同じ)。
    pub fn capacity_full(&self, lane: &str, capacity_max: usize) -> bool {
        if lane == "manual" {
            return false;
        }
        self.0.lock().unwrap().admission_used() >= capacity_max
    }

    /// hello snapshot(PBI-0229)。`capacity.max` は呼び手(adopt の同時実行上限 4)が決める。
    ///
    /// 死んだ行は **snapshot に出さないだけで registry からは消さない** —— 掃くのは reaper
    /// だけ(admission_check の「exit 済みの行はここでは消さない」と同じ規則)。ここで消すと、
    /// 子が死んでから reaper(250ms)が掃くまでの窓で来た hello / CLI status が行を奪い、
    /// reaper は `session_result` を永久に運べなくなる(server 側の owner_session_end も
    /// session_interrupted(AC-B8-2)も書かれず pending が凍結する)。
    /// `capacity.used` は **admission 対象の lane だけ** を数える —— 免除の manual を数えると
    /// 「満杯表示なのに実際は auto が取れる」という嘘になる(AC-A5-2)。数えるのは
    /// capacity_full(wake の門)と同じ admission_used(PBI-0391)。
    pub fn hello_snapshot(&self, capacity_max: usize) -> (Value, Value) {
        let mut inner = self.0.lock().unwrap();
        let used = inner.admission_used();
        let mut list: Vec<Value> = Vec::new();
        for s in inner.sessions.values_mut() {
            let dead = s.child.is_some() && !s.alive();
            if dead {
                continue;
            }
            list.push(json!({
                "request_id": s.request_id,
                "lane": s.lane,
                "account_id": s.account_id,
                "thread_id": s.thread_id,
                "runtime": s.runtime,
                "started_at": s.started_at,
                "state": state_of(s),
                "last_tool": s.last_tool,
                "tool_count": s.tool_count,
            }));
        }
        list.sort_by(|a, b| a["started_at"].as_u64().cmp(&b["started_at"].as_u64()));
        (
            Value::Array(list),
            json!({ "max": capacity_max, "used": used }),
        )
    }

    /// 生存確認つき reaper の起動。exit を観測したら `session_result` を送って終わる。
    pub fn spawn_reaper(&self, tx: UnboundedSender<Value>) {
        let sessions = self.0.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(REAP_POLL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let Some(frame) = Sessions(sessions.clone()).reap_once() else { continue };
                let _ = tx.send(frame);
            }
        });
    }
}

// **止める単位は process group**(PBI-0403)。直の子だけに送ると、その下の tool 実行 /
// MCP server / node が孤児で生き残るのに `session_result` は「終わった」と報告する。
// 子は `launch_in` の `process_group(0)` で group leader なので **pgid == 子の pid**
// (借用元 process-wrap も `pre_spawn` で `process_group(0)` → `killpg(pgid, sig)` の同じ形)。
//
// **pgid を Session に保存しない**のは、保存した値が「掃かれた後」も残るから ——
// 呼び手はその都度 `child.id()` から引く(回収済みの handle は None を返すので、
// 再利用された pid の他人の group を撃たない)。
//
// 実体は `crate::procgroup::kill_group`(PBI-0405 で分離。`sync.rs` / `adopt.rs` の
// timeout-で-見捨てる spawn 口も同じ関数を呼ぶ —— leaf module にしたのは、`#[path]` で
// src を取り込む統合 test が `launch.rs` 以下(egress / registry / sandbox / discovery)を
// 丸ごと引きずり込まずに済むようにするため)。

/// 4 状態(AC-A5-3)。cancel 済み = stopping / tool 呼び出しまで観測 = starting。
fn state_of(s: &Session) -> &'static str {
    if s.cancel_reason.is_some() {
        "stopping"
    } else if s.tool_count > 0 {
        "running"
    } else {
        "starting"
    }
}

/// hook socket の JSON 行(`{cmd,path}` 以外)を捌く。戻り値は socket へ書き戻す 1 行
/// (status / CLI cancel だけが答える。tool は投げっぱなし)。
pub fn handle_hook_json(
    sessions: &Sessions,
    tx: &UnboundedSender<Value>,
    line: &Value,
    now_ms: u64,
    capacity_max: usize,
) -> Option<String> {
    let typ = line.get("type")?.as_str()?;
    match typ {
        "tool" => {
            let sid = line.get("session")?.as_str()?;
            let tool = line.get("tool")?.as_str()?;
            if let Some(mut frame) = sessions.tool_call(sid, tool, now_ms) {
                if frame.get("capped") == Some(&Value::Bool(true)) {
                    eprintln!(
                        "broker: tool cap reached for session {sid} — killing (OPENROLY_SESSION_TOOL_CAP)"
                    );
                    sessions.cancel_tool_capped(sid);
                    frame["capped"] = Value::Null;
                }
                let _ = tx.send(frame);
            }
            None
        }
        // CLI(openroly status)からの一覧要求。server を経由しない = broker が正本
        "status" => {
            let (list, capacity) = sessions.hello_snapshot(capacity_max);
            Some(json!({ "sessions": list, "capacity": capacity }).to_string())
        }
        // CLI(openroly cancel)からの直接 stop。**同一端末の人の操作**だけがここへ来る
        // (socket は 0600 で同一 user 限定。server 経由の cancel は WS の cancel frame)
        "cancel" => {
            let sid = line.get("session")?.as_str()?;
            let ok = sessions.cancel(sid, "cancelled");
            Some(json!({ "ok": ok }).to_string())
        }
        _ => None,
    }
}

/// `OPENROLY_SESSION_TOOL_CAP`。壊れた値は無制限(None)に倒す(上限は owner が決める物で、
/// 誤設定で床を殺すより無制限のまま人に見せる側)。
pub fn tool_cap_from_env(raw: Option<&str>) -> Option<u32> {
    raw.and_then(|v| v.parse::<u32>().ok()).filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;

    async fn sleep_child(secs: &str) -> Child {
        let mut cmd = Command::new("sleep");
        cmd.arg(secs).kill_on_drop(true);
        // 本番の spawn 口(launch_in)と同じく group leader にする(PBI-0405)。これが無いと
        // `cancel_with_escalate` の SIGTERM(kill_group)は「自分の pid と同じ pgid」を持つ group が
        // 存在しないため無音で外れ、`capacity_gate_denies_fifth_and_matches_hello_display` は
        // 猶予(CANCEL_ESCALATE_MS=5000ms)後の直 kill 頼みになる。その猶予とテスト自身の deadline
        // (同じ 5 秒)が実質マージン 0 で競走し、単独実行でも 10 回中 4 回 timeout していた(実測)。
        #[cfg(unix)]
        cmd.process_group(0);
        cmd.spawn().unwrap()
    }

    /// SIGTERM を無視する子(trap)。TERM → SIGKILL の 2 段のうち **TERM で死なない** 側を
    /// 再現する —— stopping 状態を確実に観測する窓(escalate 猶予)を作る為に test でだけ使う。
    /// trap の設置完了を stdout の 1 行で待ってから返す(trap 前 の TERM は既定動作で死ぬ =
    /// 機の負荷で exec が遅れた test だけ赤くなる flake の元)
    async fn term_ignoring_child() -> Child {
        use tokio::io::AsyncReadExt;
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; echo ready; exec sleep 30")
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut out = child.stdout.take().unwrap();
        let mut buf = [0u8; 6]; // "ready\n"
        out.read_exact(&mut buf).await.unwrap();
        child
    }

    /// **孫を持つ子**を production の spawn 口(`launch_with_scope` → `launch_in`)で起こす
    /// (PBI-0403)。ここを通さずに test の中で `Command::new` すると、`process_group(0)` を
    /// 消しても test だけが緑のまま残る「3 つ目の口」になる —— 起こす口は本番と同じ 1 本にする。
    ///
    /// `sh -c` は program に置けない(PBI-0244 の deny が spawn 直前で止める)ので shebang の
    /// script file にする。**exec は pid を変えない**ので、起きるのは同じ 1 本。
    /// 孫は `sleep &` の background job —— 非対話 sh は job control を持たないので
    /// **子と同じ process group** に入る(= 直の子だけに signal を送ると生き残る当の相手)。
    /// `ignore_term` の時は `trap '' TERM` を **background job より先**に置く: SIG_IGN は
    /// fork と exec を跨いで継がれるので、**子も孫も TERM を無視する**(escalate の SIGKILL でだけ死ぬ)。
    /// 孫の `sleep` を 120 秒にしてあるのは、検査が赤い時に残る孤児が自分で消える為
    /// (共有の機械に置き去りにしない)。
    async fn child_with_grandchild(
        tag: &str,
        ignore_term: bool,
        tail: &str,
    ) -> (Child, u32, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir()
            .join(format!("openroly-pbi0403-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("grandchild.pid");
        let script = dir.join("spawn-grandchild");
        let trap = if ignore_term { "trap '' TERM\n" } else { "" };
        // pid は tmp へ書いてから mv(部分書き込みを孫の pid として読まない)
        std::fs::write(
            &script,
            format!("#!/bin/sh\n{trap}sleep 120 &\necho $! > \"$1.tmp\"\nmv \"$1.tmp\" \"$1\"\n{tail}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let child = crate::launch::launch_with_scope(
            "grandchild-probe",
            &script.to_string_lossy(),
            &[pidfile.to_string_lossy().to_string()],
            &["grandchild-probe".to_string()],
            None,
            None,
            None,
        )
        .expect("probe should spawn");
        // **孫が起きるまで待つ** —— 起きる前に cancel すると、何も測っていない緑になる
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let gpid = loop {
            if let Some(p) = std::fs::read_to_string(&pidfile)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
            {
                break p;
            }
            assert!(std::time::Instant::now() < deadline, "孫が起きない(script が動いていない)");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        (child, gpid, dir)
    }

    /// pid が居るか。**signal は送らない**(`sig = 0` は存在と権限の確認だけ)。
    fn pid_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// 孫が消えるまで待つ。消えなければ false(= 孤児が残っている)。
    async fn wait_gone(pid: u32, within: Duration) -> bool {
        let deadline = std::time::Instant::now() + within;
        while pid_alive(pid) {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }

    /// 検査の後始末。赤い回でも共有の機械に `sleep` を置き去りにしない(lessons 08)。
    fn cleanup(gpid: u32, dir: &std::path::Path) {
        unsafe { libc::kill(gpid as i32, libc::SIGKILL) };
        let _ = std::fs::remove_dir_all(dir);
    }

    fn session(rid: &str, lane: &str, child: Child) -> Session {
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

    // PBI-0441 module review: C1 の session は root の sudo + pool の uid の下で走り、broker の killpg は
    // どちらにも届かない(kill(2) の uid 一致)。cancel は **pool の uid として** TERM を打つ。
    // sudo は test から叩かない —— `c1::run_as` は test build では argv を記録するだけ。
    #[tokio::test]
    async fn cancel_signals_a_c1_session_as_its_pool_uid() {
        let _ = crate::c1::take_run_as_log();
        let as_pool = |log: &[Vec<String>], user: &str, sig: &str| {
            log.iter().any(|a| {
                a.len() == 8
                    && a[..5] == ["/usr/bin/sudo", "-n", "-u", user, "--"]
                    && a[5..] == ["/bin/kill".to_string(), format!("-{sig}"), "-1".to_string()]
            })
        };
        let home = std::env::temp_dir().join(format!("openroly-sessions-c1-{}", std::process::id()));
        let sessions = Sessions::new(None);

        // C1 の session: pool の uid として TERM
        let child = sleep_child("30").await;
        let gpid = child.id().unwrap();
        let config = crate::egress::EgressConfig { allow: Vec::new(), events: None, upstream_override: None, observe: None };
        let mut egress = crate::egress::start(config, "rid-c1").unwrap();
        egress.c1 = Some(crate::c1::fake_session_for_test("_openroly_s577", &home));
        let mut row = session("rid-c1", "auto", child);
        row.egress = Some(egress);
        sessions.insert(row);
        assert!(sessions.cancel_with_escalate("rid-c1", "test", Duration::from_secs(30)));
        let log = crate::c1::take_run_as_log();
        assert!(as_pool(&log, "_openroly_s577", "TERM"), "cancel が pool の uid として TERM を打っていない: {log:?}");
        cleanup(gpid, &home);

        // C1 でない session: run-as を 1 本も打たない(知らない uid に signal を撒かない)
        let plain = sleep_child("30").await;
        let plain_gpid = plain.id().unwrap();
        sessions.insert(session("rid-plain", "draft", plain));
        assert!(sessions.cancel_with_escalate("rid-plain", "test", Duration::from_secs(30)));
        let log = crate::c1::take_run_as_log();
        assert!(log.is_empty(), "C1 でない session に run-as を打った: {log:?}");
        cleanup(plain_gpid, &home);
    }

    #[tokio::test]
    async fn admission_rejects_second_same_lane() {
        let c1 = sleep_child("30").await;
        let c2 = sleep_child("30").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-1", "auto", c1));
        // 同じ (account, lane) の 2 本目は断られる(AC-X3)
        assert_eq!(sessions.admission_check("acc-1", "auto").as_deref(), Some("rid-1"));
        // 別 lane は通る
        assert_eq!(sessions.admission_check("acc-1", "owner"), None);
        // manual は常に通る(admission 対象外)
        assert_eq!(sessions.admission_check("acc-1", "manual"), None);
        sessions.insert(session("rid-2", "manual", c2));
        // manual が居ても次の manual は通る
        assert_eq!(sessions.admission_check("acc-1", "manual"), None);
    }

    #[tokio::test]
    async fn admission_lets_work_lane_run_side_by_side() {
        // PBI-0439: lane "work" は work ごとに別 session。本数は server が持つので admission は断らない
        let c1 = sleep_child("30").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-w1", "work", c1));
        assert_eq!(sessions.admission_check("acc-1", "work"), None);
        // 端末全体の上限は今まで通り work も数える(免除は admission だけ)
        assert!(sessions.capacity_full("work", 1));
    }

    #[tokio::test]
    async fn admission_frees_when_child_exits() {
        let mut c1 = sleep_child("0").await; // すぐ死ぬ
        let _ = c1.wait().await; // exit を確定させてから載せる
        let c2 = sleep_child("30").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-old", "auto", c1));
        // 死んだ行は admission を塞がない(handle の try_wait = Some で見る。pid ではない)
        assert_eq!(sessions.admission_check("acc-1", "auto"), None);
        sessions.insert(session("rid-new", "auto", c2));
        assert_eq!(sessions.admission_check("acc-1", "auto").as_deref(), Some("rid-new"));
    }

    #[tokio::test]
    async fn cancel_sigterm_then_kill() {
        let c1 = sleep_child("30").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-c", "auto", c1));
        // SIGTERM で死ぬ子(sleep)なら最初の TERM で終わる。escalate を短くして検査を速く
        assert!(sessions.cancel_with_escalate("rid-c", "cancelled", Duration::from_millis(300)));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if !sessions.status_alive("rid-c") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "child did not die");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // 終了した行は registry から掃ける(reap_once が frame を出す)
        let frame = sessions.reap_once().expect("session_result");
        assert_eq!(frame["requestId"], "rid-c");
        assert_eq!(frame["reason"], "cancelled");
        assert!(frame["exit_code"].is_null());
    }

    // ------------------------------------- PBI-0403: 止める単位は process group

    /// **AC-1 / AC-2 / AC-X3**。人の Stop(`cancel`)で **孫まで死ぬ**。
    /// AC-1 = この検査を `process_group(0)` の**前**に回すと、孫だけが生き残って赤くなる
    /// (直の子には TERM が届くので「終わった」と報告されるのに、tool 実行 / MCP server /
    /// node に相当する孫は書き込みと通信を続ける)。
    #[tokio::test]
    async fn cancel_kills_the_grandchild_too() {
        let (child, gpid, dir) = child_with_grandchild("cancel", false, "exec sleep 120").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-g", "auto", child));
        assert!(pid_alive(gpid), "孫が起きていない = 何も測っていない");

        // AC-X3: 他人の account の cancel は group 化しても通らない(床が緩んでいない)。
        // **返り値だけでなく孫の生死で測る** —— 送っていたらここで死ぬ
        assert!(!sessions.cancel_scoped("rid-g", "acc-2", "cancelled"));
        assert!(pid_alive(gpid), "他人の cancel で group に signal が飛んだ");

        assert!(sessions.cancel_scoped("rid-g", "acc-1", "cancelled"));
        assert!(
            wait_gone(gpid, Duration::from_secs(10)).await,
            "孫({gpid})が生き残った —— 直の子にしか signal が届いていない(PBI-0403 AC-2)"
        );
        // 直の子も死んで、reaper は今までどおり session_result を運ぶ
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let frame = loop {
            if let Some(f) = sessions.reap_once() {
                break f;
            }
            assert!(std::time::Instant::now() < deadline, "子が reaper に掃われない");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(frame["requestId"], "rid-g");
        assert_eq!(frame["reason"], "cancelled");
        cleanup(gpid, &dir);
    }

    /// **AC-3 / AC-4**。`tool_cap` 到達の kill(= 3 本目の入口)から入っても、TERM を
    /// **子も孫も無視する**組で、猶予後の SIGKILL が **group ごと**効く。
    /// 入口が 1 関数(`cancel_with_escalate`)に合流している事を、spy ではなく
    /// 「この入口から入って孫が死ぬ」で測る。
    #[tokio::test]
    async fn tool_cap_escalate_kills_the_whole_group() {
        let (child, gpid, dir) = child_with_grandchild("toolcap", true, "exec sleep 120").await;
        let sessions = Sessions::new(Some(1));
        sessions.insert(session("rid-cap-g", "auto", child));

        let frame = sessions.tool_call("rid-cap-g", "inbox_read", 1).unwrap();
        assert_eq!(frame["capped"], Value::Bool(true));
        // handle_hook_json と同じ流れ。猶予を 200ms にして escalate だけを測る
        sessions.cancel_with_escalate("rid-cap-g", "tool_cap", Duration::from_millis(200));
        assert!(
            wait_gone(gpid, Duration::from_secs(10)).await,
            "TERM を無視する孫({gpid})が escalate の SIGKILL で死んでいない(PBI-0403 AC-3)"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while sessions.status_alive("rid-cap-g") {
            assert!(std::time::Instant::now() < deadline, "子が escalate で死なない");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cleanup(gpid, &dir);
    }

    /// **AC-5 / AC-X2**。自然終了した session は今までどおり `session_result{exit_code}` を
    /// 返し(group 化で回収は壊れない)、**掃かれた後の cancel は signal を 1 つも送らない**。
    ///
    /// 「送っていない」は返り値では測れないので **孫を証人にする**: 子が exit しても孫は
    /// 生き続け、pgid の group はまだ在る。もし pgid を保存して撃つ実装なら、ここで孫が死ぬ
    /// (= pid が再利用された後なら **他人の group** を撃つのと同じ形)。
    #[tokio::test]
    async fn reaped_session_returns_exit_code_and_cancel_signals_nothing() {
        let (child, gpid, dir) = child_with_grandchild("reap", false, "exit 7").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-r", "auto", child));

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let frame = loop {
            if let Some(f) = sessions.reap_once() {
                break f;
            }
            assert!(std::time::Instant::now() < deadline, "自然終了が reaper に拾われない");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(frame["exit_code"], json!(7), "group 化で exit code の回収が壊れた(AC-5)");
        assert_eq!(frame["reason"], Value::Null);

        // 掃かれた行への cancel は false。孫は生きたまま = signal は 1 つも出ていない
        assert!(!sessions.cancel("rid-r", "cancelled"));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(pid_alive(gpid), "回収済みの session の cancel が group へ signal を送った(AC-X2)");
        cleanup(gpid, &dir);
    }

    #[tokio::test]
    async fn cancel_scoped_rejects_other_account() {
        // AC-X1 の broker 側の床: request_id を知っていても他人の account の cancel/status には触れない
        let c1 = sleep_child("30").await;
        let c2 = sleep_child("30").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-a", "owner", c1));
        let mut other = session("rid-b", "owner", c2);
        other.account_id = "acc-2".to_string();
        sessions.insert(other);

        // 他人の request_id を持つ接続が cancel を撃っても false で、子は生き続ける
        assert!(!sessions.cancel_scoped("rid-a", "acc-2", "cancelled"));
        assert!(sessions.status_alive("rid-a"), "他人の cancel では止まらない");
        // 自分の物なら通る
        assert!(sessions.cancel_scoped("rid-a", "acc-1", "cancelled"));
        // status も同じ床: 他人の id・registry に無い id はどちらも false
        assert!(!sessions.status_alive_scoped("rid-b", "acc-1"));
        assert!(sessions.status_alive_scoped("rid-b", "acc-2"));
        assert!(!sessions.status_alive_scoped("rid-nobody", "acc-1"));
    }

    #[tokio::test]
    async fn tool_cap_kills_at_limit_and_below_passes() {
        // A6-2 / A6-3。上限 2: 2 回目で capped、3 回目の前に行が消える方向
        let c1 = term_ignoring_child().await; // TERM を無視する → escalate(SIGKILL)まで生きる
        let c2 = sleep_child("30").await;
        let sessions = Sessions::new(Some(2));
        sessions.insert(session("rid-cap", "auto", c1));
        sessions.insert(session("rid-ok", "auto", c2));
        // 別 (account,lane) で無いと admission に引っかかるが、insert は直接なので共存できる
        let f1 = sessions.tool_call("rid-ok", "inbox_list", 1).unwrap();
        assert_eq!(f1["capped"], Value::Bool(false));
        // A6-3: 上限未満は通る(子は生きている)
        assert!(sessions.status_alive("rid-ok"));

        let f2 = sessions.tool_call("rid-cap", "inbox_read", 2).unwrap();
        assert_eq!(f2["capped"], Value::Bool(false));
        let f3 = sessions.tool_call("rid-cap", "inbox_read", 3).unwrap();
        assert_eq!(f3["capped"], Value::Bool(true));
        // hook 側(handle_hook_json)と同じ流れ: capped を見たら kill を起こす(AC-A6-2)
        sessions.cancel_tool_capped("rid-cap");
        // 上限で kill が起きる → stopping → 死ぬ(map の順は当てにならないので requestId で引く)
        let list = sessions.hello_snapshot(4).0;
        let capped_row = list
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["request_id"] == json!("rid-cap"))
            .expect("rid-cap row");
        assert_eq!(capped_row["state"], json!("stopping"));
        // escalate(5s)後に SIGKILL が来て死ぬ。TERM を無視する子なので死ぬのはこの 1 経路だけ
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while sessions.status_alive("rid-cap") {
            assert!(std::time::Instant::now() < deadline, "cap kill did not fire");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(sessions.status_alive("rid-ok"), "上限未満の子は生き続ける(AC-A6-3)");
    }

    #[tokio::test]
    async fn hello_snapshot_reports_state_and_capacity() {
        let c1 = sleep_child("30").await;
        let sessions = Sessions::new(None);
        sessions.insert(session("rid-h", "owner", c1));
        let (list, cap) = sessions.hello_snapshot(4);
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["lane"], json!("owner"));
        assert_eq!(list[0]["state"], json!("starting"));
        assert_eq!(cap["used"], json!(1));
        assert_eq!(cap["max"], json!(4));
    }

    #[test]
    fn tool_cap_env_parses_and_rejects_junk() {
        assert_eq!(tool_cap_from_env(Some("50")), Some(50));
        assert_eq!(tool_cap_from_env(Some("0")), None);
        assert_eq!(tool_cap_from_env(Some("abc")), None);
        assert_eq!(tool_cap_from_env(None), None);
    }

    // ------------------------------------- PBI-0391: wake→spawn の同時実行上限の門

    /// 4(= ADOPT_CONCURRENCY)本を **別々の (account, lane)** で立てた状態 —— どの行も
    /// admission は通す組み合わせ —— で 5 本目の門が閉じ、hello の capacity(表示)と
    /// 一致する事を見る(AC-1)。0229 review の破れは「別 account・別 lane の 5 本目は
    /// spawn する」だったので、admission では止められないこの 1 本をこの門だけで止める。
    #[tokio::test]
    async fn capacity_gate_denies_fifth_and_matches_hello_display() {
        let sessions = Sessions::new(None);
        let lanes = ["auto", "owner", "draft", "work"];
        for (i, lane) in lanes.iter().enumerate() {
            // 立てる前は開いている(i 本 < 4)。4 本目を立てた後は下で閉じる
            assert!(!sessions.capacity_full("takeover", 4), "{i} 本目の前は門が開いているはず");
            let c = sleep_child("30").await;
            let mut row = session(&format!("rid-{i}"), lane, c);
            row.account_id = format!("acc-{i}");
            sessions.insert(row);
            // 5 本目はさらに別の (account, lane) —— admission は通る(壊れの再現条件)
            assert_eq!(sessions.admission_check("acc-new", "takeover"), None);
        }
        // 表示: used==4==max(= web の "No capacity right now"・AC-A5-2)
        let (_, cap) = sessions.hello_snapshot(4);
        assert_eq!(cap["used"], json!(4));
        assert_eq!(cap["max"], json!(4));
        // 実際: 5 本目は断る。**表示と一致する事だけが要件**(AC-1)
        assert!(sessions.capacity_full("takeover", 4));

        // 上限は **同時実行数** で件数では無い: 1 本 cancel して reaper が掃えば門は開く
        assert!(sessions.cancel("rid-0", "test"));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while sessions.reap_once().is_none() {
            assert!(std::time::Instant::now() < deadline, "cancel した子が reaper に掃われない");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!sessions.capacity_full("takeover", 4), "枠が同時実行数に戻らない");
    }

    /// manual は used にも数えず門にも掛けない(admission の免除と同じ扱い・スコープ外「manual
    /// は触らない」)。死んだ行は used を消費しない(掃くのは reaper だけ・ hello_snapshot と同規則)。
    #[tokio::test]
    async fn capacity_gate_exempts_manual_and_dead_rows_do_not_count() {
        let sessions = Sessions::new(None);
        for i in 0..4 {
            let c = sleep_child("30").await;
            sessions.insert(session(&format!("rid-man{i}"), "manual", c));
        }
        // manual だけ並んでいても used==0(0229 review 破れ 2 の規則)で、manual の wake も門を通る
        let (list, cap) = sessions.hello_snapshot(4);
        assert_eq!(list.as_array().unwrap().len(), 4);
        assert_eq!(cap["used"], json!(0));
        assert!(!sessions.capacity_full("manual", 4));

        // 死んだ行(reaper がまだ掃っていない窓)は used を消費しない = 門も閉じない
        let mut dead = sleep_child("0").await;
        let _ = dead.wait().await;
        sessions.insert(session("rid-dead", "auto", dead));
        let (_, cap) = sessions.hello_snapshot(4);
        assert_eq!(cap["used"], json!(0));
        assert!(!sessions.capacity_full("auto", 4));
    }

    #[test]
    fn hook_json_tool_line_produces_update_and_status_answers() {
        let sessions = Sessions::new(None);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        // status は空でも答える(CLI は server 経由でなく broker に聞く)
        let answer = handle_hook_json(&sessions, &tx, &json!({"type":"status"}), 1, 4).unwrap();
        assert!(answer.contains("\"sessions\":[]"));
        // tool 行は registry に無い session では何もしない(fail-open)
        assert_eq!(
            handle_hook_json(&sessions, &tx, &json!({"type":"tool","session":"nope","tool":"inbox_read"}), 1, 4),
            None
        );
        // cancel も registry 無しは ok:false
        assert_eq!(
            handle_hook_json(&sessions, &tx, &json!({"type":"cancel","session":"nope"}), 1, 4),
            Some(json!({"ok":false}).to_string())
        );
        let _ = rx.try_recv();
    }
}
