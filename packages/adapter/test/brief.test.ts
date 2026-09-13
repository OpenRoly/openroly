import { describe, expect, test } from "bun:test";
import { buildBrief, formatBrief, formatStatusline } from "../src/brief.ts";

// AC-12: session start(要件 §19)で見せるのは metadata のみ。本文を混ぜない。

const whoami = {
  agent_id: "agt_0123456789abcdef0123456789abcdef",
  handle: "aya",
  display_name: "Aya",
  unread: 3,
  actor: { kind: "runtime", runtime_id: "rt_claude" },
};

const messages = [
  { id: "msg_1", sender_display: "Shibu", bucket: "inbox", read: false },
  { id: "msg_2", sender_display: "Shibu", bucket: "inbox", read: false },
  { id: "msg_3", sender_display: "Ken", bucket: "inbox", read: false },
  { id: "msg_4", sender_display: "Mika", bucket: "inbox", read: true },
  { id: "msg_5", sender_display: "Unknown", bucket: "requests", read: false },
];

describe("session brief", () => {
  test("未読を sender 別に数える(既読は除く / requests は別枠)", () => {
    const brief = buildBrief(whoami, messages);
    expect(brief.handle).toBe("aya");
    expect(brief.runtime_id).toBe("rt_claude");
    expect(brief.senders).toEqual([
      { name: "Shibu", count: 2 },
      { name: "Ken", count: 1 },
    ]);
    expect(brief.requests).toBe(1);
  });

  test("本文 key を一切持たない", () => {
    const brief = buildBrief(whoami, [
      { id: "msg_1", sender_display: "Shibu", bucket: "inbox", read: false, text: "秘密の本文" },
    ]);
    const json = JSON.stringify(brief);
    expect(json).not.toContain("秘密の本文");
    for (const key of ["text", "files", "urls", "envelope", "body"]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  test("要件 §19 の表示形になる", () => {
    expect(formatBrief(buildBrief(whoami, messages))).toBe(
      ["Unread: 3", "- Shibu ×2", "- Ken ×1", "- (requests: 1)"].join("\n"),
    );
  });

  // ---- PBI-0004: unread(whoami・全期間)と内訳(直近 window)の母集団差 ----

  test("AC-1: window に未読が 1 件も無くても、未計上分を必ず 1 行にして出す", () => {
    const messages = [
      { id: "msg_a", sender_display: "Mika", bucket: "inbox", read: true },
      { id: "msg_b", sender_display: "Unknown", bucket: "requests", read: false },
    ];
    const brief = buildBrief({ ...whoami, unread: 25 }, messages);
    expect(brief.senders).toEqual([]);
    expect(formatBrief(brief)).toBe(
      ["Unread: 25", "- and 25 more", "- (requests: 1)"].join("\n"),
    );
  });

  test("AC-2: 内訳が window で頭打ちなら残りを「ほか」に出す", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg_${i}`,
      sender_display: "Alice",
      bucket: "inbox",
      read: false,
    }));
    const brief = buildBrief({ ...whoami, unread: 60 }, messages);
    expect(formatBrief(brief)).toBe(
      ["Unread: 60", "- Alice ×50", "- and 10 more"].join("\n"),
    );
  });

  test("AC-3: window が全未読を覆っていれば「ほか」は出ない", () => {
    expect(formatBrief(buildBrief(whoami, messages))).not.toContain(" more");
  });

  test("PBI-0424: 本体は handle を名乗らない(identity は status が 1 度だけ出す)", () => {
    const out = formatBrief(buildBrief(whoami, messages));
    expect(out).not.toContain("@aya");
    expect(out).not.toContain("Attached as");
    expect(out.split("\n")[0]).toStartWith("Unread: ");
  });
});

// PBI-0130: statusline の 1 行。件数だけを出す(要件 §19 の境界を CLI 面にも当てる)
describe("statusline segment", () => {
  const brief = (unread: number, requests: number) =>
    buildBrief({ ...whoami, unread }, [
      ...Array.from({ length: requests }, (_, i) => ({
        id: `msg_r${i}`,
        sender_display: "Unknown",
        bucket: "requests",
        read: false,
      })),
    ]);

  test("AC-1: 未読 0 は 📭 だけ(件数を出さない)", () => {
    const out = formatStatusline(brief(0, 0));
    expect(out).toContain("📭");
    expect(out).not.toContain("📬");
    expect(out.split("\n")).toHaveLength(1);
  });

  test("AC-2: 未読 3 は 📬3", () => {
    const out = formatStatusline(brief(3, 0));
    expect(out).toContain("📬3");
    expect(out).not.toContain("+");
    expect(out.split("\n")).toHaveLength(1);
  });

  test("AC-3: requests は +N で別枠に足す", () => {
    const out = formatStatusline(brief(5, 2));
    expect(out).toContain("📬5");
    expect(out).toContain("+2");
  });

  test("AC-X1: 本文も sender 名も handle も出さない", () => {
    const withBody = buildBrief(whoami, [
      { id: "msg_1", sender_display: "Shibu", bucket: "inbox", read: false, text: "秘密の本文" },
    ]);
    const out = formatStatusline(withBody);
    for (const leak of ["秘密の本文", "Shibu", "aya", "Aya", "msg_1"]) {
      expect(out).not.toContain(leak);
    }
  });
});
