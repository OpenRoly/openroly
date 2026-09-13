//! spawn 口が group leader にした子を、timeout / cancel で group ごと落とすための唯一の実体
//! (PBI-0403 で開き、PBI-0405 で `sessions.rs` から独立させた)。
//!
//! `launch_in`(launch.rs)/ `run_cli`・`ask_watch_paths`(sync.rs)/ `adopt_one`(adopt.rs)は
//! spawn の直前に `#[cfg(unix)] cmd.process_group(0)` を置いて子を group leader にする
//! (pgid == 子の pid)。**落とす実体はここ 1 つ**に集約し、新しい停止の仕組みを増やさない。
//! 依存を持たない leaf module にしてあるのは、`#[path]` で src を直接取り込む統合 test が
//! `sessions.rs`(→ `launch.rs` → `egress` / `registry` / `sandbox` / `discovery` …)を丸ごと
//! 引きずり込まずに済むようにするため。

/// group ごと signal を送る。呼び手はその都度 `child.id()` から pid を引く(回収済みの
/// handle は `id()` が None を返すので、再利用された pid の他人の group を撃たない)。
pub(crate) fn kill_group(pid: u32, sig: i32) {
    // `-0` は「自分の process group」= broker 自身。handle からは来ない値だが、
    // 負号を付ける前に必ず落とす(pid が undefined の時に自分ごと殺すのが典型の事故)
    if pid == 0 || pid > i32::MAX as u32 {
        return;
    }
    // SAFETY: kill(2) は signal を送るだけで、値域は 1 行上で絞ってある
    unsafe { libc::kill(-(pid as i32), sig) };
}
