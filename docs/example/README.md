# Example: optional text artifacts

This is a **fictional** one-hour fixture with six speaking Discord-account labels. It shows the transcript and AI-minutes formats **only for an instance whose operator explicitly enabled those optional providers**. A fresh installation records audio, separate tracks, a mix, and timestamped notes; it does not generate these text artifacts by default.

> The labels below (Rafael, Priya, Mei, James, Sofia, Tobias) are fictional Discord-account labels attached to separate captured streams. They preserve the platform source used by the fixture; they do not prove which human was behind an account, and a partial or failed track can still make the transcript incomplete.

- **Meeting:** Northwind — Weekly Product & Growth Sync
- **Channel:** 🔊 product-sync · **Duration:** 58min 12s · **Participants:** 6

---

## Meeting minutes (optional AI-generated artifact)

### Summary
The team reviewed launch readiness for the v3 dashboard, investigated a churn spike traced to the new onboarding flow, and green-lit the annual pricing experiment after positive results. A production incident from Tuesday was postmortem'd (a Redis eviction issue), and the group agreed to hire a second infra engineer given rising cloud costs. Launch is confirmed for next Thursday, gated on the onboarding fix and a load test.

### Decisions
- ✅ **v3 dashboard launches next Thursday**, gated on the onboarding fix + a passing load test.
- ✅ **Roll back the new onboarding flow's mandatory tour** — it correlates with the churn spike.
- ✅ **Ship the annual-plan pricing experiment to 100%** (was +18% conversion at 20% rollout).
- ✅ **Open a headcount for a second infra/SRE engineer.**
- ✅ Adopt a **weekly load test** in CI before each release.

### Action items
- [ ] **Rafael** — merge the onboarding rollback + feature-flag it (by **Wed**)
- [ ] **Mei** — run the load test against staging and share numbers (by **Wed EOD**)
- [ ] **Priya** — finalize launch email + changelog, schedule for Thu 9am (by **Thu**)
- [ ] **James** — write the Redis incident postmortem doc and add the eviction alert (by **Fri**)
- [ ] **Sofia** — open the infra/SRE job posting and share the JD for review (this week)
- [ ] **Tobias** — pull the annual-plan cohort retention at 30 days and report back (next sync)

### Topics
- `00:00:00` Kickoff & agenda
- `00:04:30` v3 dashboard launch readiness
- `00:16:10` Churn spike investigation (onboarding flow)
- `00:29:40` Pricing experiment results
- `00:39:05` Tuesday incident postmortem (Redis)
- `00:48:20` Hiring & cloud cost
- `00:55:30` Wrap-up & action items

### By participant
**Rafael (Eng lead)** — flagged the onboarding tour as the likely churn cause; owns the rollback and the launch gate.
**Mei (Backend)** — raised the missing load test; will run it against staging before launch.
**Priya (Product)** — confirmed launch scope and comms; owns the launch email and changelog.
**James (SRE)** — diagnosed the Redis eviction incident; owns the postmortem and alerting.
**Sofia (Eng manager)** — pushed for the infra hire given on-call load; owns the job posting.
**Tobias (Growth)** — presented the pricing experiment; owns the 30-day retention readout.

---

## Transcript (optional ASR excerpt)

> In this fictional fixture, the transcript spans the whole hour and uses the captured account labels with clickable timestamps. A real result depends on the configured ASR provider and may be partial. A representative excerpt:

```
[00:00:12] Priya: Alright, everyone's here — let's keep this to an hour. Three big things: launch readiness, the churn number, and Tobias's pricing results.
[00:00:31] Rafael: Before that — can we timebox the incident from Tuesday? James has the writeup half done.
[00:00:45] Priya: Good call, we'll do the postmortem near the end. Launch first.
[00:04:33] Priya: v3 dashboard — where are we? Are we go for Thursday?
[00:05:02] Rafael: Code's basically done. My worry isn't the dashboard, it's the onboarding flow we shipped last week.
[00:05:20] Mei: And we still don't have a load test in CI. We're guessing on capacity.
[00:16:14] Priya: Okay, the churn spike. It jumped from 3.1% to 4.4% in two weeks. What changed?
[00:16:39] Rafael: The only thing that shipped in that window is the mandatory onboarding tour.
[00:17:05] Tobias: The funnel backs that up — 22% of new users drop on step 3 of the tour.
[00:18:10] Sofia: So we roll it back and make it skippable?
[00:18:22] Rafael: Roll it back for launch, feature-flag it, and we redesign it after.
[00:29:44] Tobias: Pricing — the annual plan test at 20% rollout is up 18% on conversion, no hit to refunds.
[00:31:12] Priya: That's strong. Any reason not to go to 100%?
[00:31:30] Tobias: None I can see. I'll pull 30-day retention on the annual cohort to be sure.
[00:39:09] James: Tuesday — Redis hit maxmemory and started evicting keys we assumed were durable. Sessions dropped.
[00:41:50] James: Fix is a bigger instance plus an eviction alert. I'll write the postmortem by Friday.
[00:48:25] Sofia: Which brings up on-call. We're one deep on infra. I want to open a second SRE role.
[00:49:40] Mei: +1. The load test and the incident both trace back to us being stretched.
[00:55:34] Priya: Okay — action items. Rafael: onboarding rollback by Wednesday. Mei: load test by Wednesday EOD...
[00:57:48] Priya: ...Sofia opens the SRE role, Tobias gets retention numbers. Launch Thursday if the gate's green. Thanks all.
```

---

In a real instance, retained audio, tracks, the mix, notes, and any enabled text artifacts stay behind Discord login, current allowlisted-guild membership, and the meeting ACL. See the [main README](../../README.md) to run your own instance.
