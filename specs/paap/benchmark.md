# PAAP Continuity Benchmark

Status: **informative** · for `paap/0.1`

This document is **informative**: it is not part of conformance (§8 of the [specification](README.md)), and an
implementation does not need it to claim L1, L2, or L3. It fixes the words a continuity benchmark uses, so that a
number one implementation reports means the same as the same number from another. Field names are those of §4.4.

In the OpenRoly repository, the judgement is `packages/core/src/continuity-metrics.ts`.

## 1. A run

A run is one handoff of one task to a target runtime, observed from outside the runtime.

| Term | Meaning |
|---|---|
| T0 | The time the handoff started (freeze, §6) |
| actions | The target runtime's tool calls, each with a time, a kind (`read`, `exec`, `edit`, `tool`, or `say`), and a target: the file read or edited, the command run, or the issue named |
| useful targets | The targets that are a correct next step for the task: the right file, the test that has to run, the issue of the goal. The task defines this set, not the judge |
| useful action | The earliest action at or after T0 whose kind is not `say` and whose target is a useful target. Saying "I will continue" is not continuing, even when it names the right file |
| T1 | The time of the useful action |
| target view | The fields the target runtime was shown: the brief sections of §7, plus `work_id` and `content_hash` |
| user events | What a person did to the work after T0: edits to its `goal`, `decisions`, or next step, and messages |
| unmeasured | A run whose tool calls could not be recorded |

No judgement depends on which runtime the target is, and no model judges a run.

## 2. Metrics

Rates are over measured runs. An unmeasured run is in neither the numerator nor the denominator: it is not zero
seconds, not a failure, and not a loss. With no measured run, a metric is reported as not measured, never as 0%.

Every rate is reported with its n and a 95% interval (Wilson), and every duration as a median with its 90th
percentile beside it, so that a tail is not hidden behind a middle value. With fewer than ten measured runs the
90th percentile is not reported rather than extrapolated from one long run.

Cost is reported per finished job: everything the measured runs consumed, including the runs that never
finished, divided by the runs that did. Dividing by all runs instead would make a method that gives up early
look cheap. What the unfinished runs consumed is reported beside it, never folded into it, and a run whose
runtime reports no consumption is in neither part.

The input half of that cost is also reported by origin: what the handoff handed over, what the runtime's own
system prompt and tool definitions cost before any handoff, what the next AI read for itself, and what its own
replies added back. A method can only be made cheaper where its tokens actually are, and handing over less does
not move the part that is fixed. The origins are shares of the measured input, never an estimate added on top,
so they sum to it; a reply whose origin cannot be determined is reported as unattributed rather than assigned,
and a run whose origins were not recorded is left out of the breakdown rather than counted as zero.

| Metric | Definition |
|---|---|
| `continuation_success` | Share of runs that have a useful action and no human recovery |
| `time_to_useful_action` | Median of T1 − T0 in seconds, over the runs that have a useful action |
| `human_recovery` | Share of runs in which a person edited the work's `goal`, `decisions`, or next step, or sent a message, after T0 and before the useful action (at any time after T0 when there is none). Every such event counts, a thank-you included, so this errs high. It is measured only on runs in which a person was able to step in; on unattended runs it is reported as not measured, not as 0%. In the benchmark the person is a fixed script: after the next AI stops, if the task is not done, the script first sends one message with no content ("Please continue until the task is done."), and if the task is still not done, it pastes the work's goal, decisions, and failed attempts. The reported rate is the share of runs that needed the second message; runs the script could not reach are left out of the rate |
| `state_loss` | Share of runs that are not zero-loss (§3) |
| `recovery_after_failed_handoff` | Share of runs with an injected failure in which the work is recovered: the checkpoint the handoff named still exists (**I-7**), a handoff is committed (after a failed one, by asking to continue once more), and its target has a continuation success. The injected failures are a usage limit at the source, a killed target, a cut network, a target that fails to start, and a handoff that times out. For the last four, a run whose handoff did not fail is not counted: the failure did not happen |
| `cutoff_rate` | Share of runs whose first target session ended right after a tool call, with no reply from the model. A run that did not record how its session ended is in neither the numerator nor the denominator. Whether the session was woken once more, and whether that run then finished, are reported beside the rate, never folded into it. It is read from the target's own session, so runs in which a person could step in are counted here too |
| `final_task_success` | Share of runs whose task is finished correctly once the target stops: the target's own tests pass, the task's completion tests pass (including tests the target was never shown), the tests that were there before still pass, and the target neither repeated a failed attempt from the checkpoint nor went against one of its decisions. A run whose result was not checked is in neither the numerator nor the denominator |

## 3. State loss categories

A category is **lost** when the source checkpoint has a value for its field (present, and not an empty string,
array, or object) and the field is not in the target view. A field the source checkpoint never had cannot be lost.

A run is **zero-loss** when no category is lost and the source checkpoint still exists after the handoff, whatever
the handoff's final state (**I-7**).

| Category | Field | In the checkpoint |
|---|---|---|
| `work` | `work_id` | top level |
| `checkpoint` | `content_hash` | top level |
| `git_changes` | `git_state` | `body` |
| `decisions` | `decisions` | `body` |
| `failed_attempts` | `failed_attempts` | `body` |
| `artifacts` | `relevant_artifacts` | `body` |
| `open_questions` | `unresolved_questions` | `body` |
| `capability_requirements` | `capability_requirements` | `body` |

`goal`, `current_state`, and `relevant_memory` are not loss categories in this revision.
