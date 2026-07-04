# asaya — Early Discriminant-Validity Report

**Scenario:** `fde-db-triage-pro` (Forward Deployed Engineer style: ambiguous customer ticket, misleading teammate hint, mid-session requirement change).
**Run:** 2026-06-20T00:45:50.380Z → 2026-06-20T03:16:11.630Z (150.4 min wall clock).
**Method:** 3 archetypal FDE candidate playbooks × 15 independent trials each = 45 live end-to-end sessions, scored post-hoc by the Analysis Agent on 8 weighted competencies. Within-archetype variance comes from LLM nondeterminism in the two persona agents (Dana, Sam) and in the judge.

## Headline

| Archetype | Overall (mean ± σ) | 95% CI | n |
|---|---:|---:|---:|
| **Strong FDE** | 4.70 ± 0.15 | [4.62, 4.79] | 15 |
| **Median FDE** | 2.59 ± 0.09 | [2.54, 2.65] | 14 |
| **Weak FDE** | 1.02 ± 0.07 | [0.97, 1.07] | 10 |

<details><summary>Raw trial scores</summary>

- **Strong FDE** — 4.51, 4.51, 4.51, 4.76, 4.58, 4.80, 4.88, 4.92, 4.76, 4.62, 4.51, 4.76, 4.76, 4.92, 4.76
- **Median FDE** — 2.66, 2.54, 2.62, 2.50, 2.66, 2.66, 2.66, 2.66, 2.38, 2.66, 2.50, 2.66, 2.50, 2.66
- **Weak FDE** — 1.00, 1.00, 1.00, 1.22, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00

</details>

## Discriminant-validity verdict

- ✅ **Rank-order holds on means**: Strong > Median > Weak.
- ✅ **95% confidence intervals do not overlap**: Strong's lower bound > Median's upper bound, and Median's lower bound > Weak's upper bound. This is the strongest of the separation claims.
- ✅ **Pairwise gaps exceed within-archetype noise**: both Strong–Median and Median–Weak gaps are larger than the pooled within-archetype standard deviation.
- ✅ **Trial-level separation**: every Strong trial outscored every Weak trial.
- **Per-competency consistency:** Strong ≥ Median ≥ Weak holds on 100% of the 8 competencies.

**Headline:** scores separate strong from weak FDE candidates consistently across trials, with non-overlapping 95% confidence intervals.

## Per-competency mean (± σ)

| Competency | Strong FDE | Median FDE | Weak FDE |
|---|---:|---:|---:|
| Design Under Constraints | 4.60 ± 0.51 | 3.00 ± 0.00 | 1.00 ± 0.00 |
| Teamwork | 5.00 ± 0.00 | 2.00 ± 0.00 | 1.10 ± 0.32 |
| Data Fluency | 5.00 ± 0.00 | 3.00 ± 0.00 | 1.00 ± 0.00 |
| Execution | 5.00 ± 0.00 | 3.00 ± 0.00 | 1.00 ± 0.00 |
| Problem Framing | 4.20 ± 0.41 | 2.57 ± 0.65 | 1.00 ± 0.00 |
| Outcome Communication | 4.73 ± 0.46 | 3.00 ± 0.00 | 1.00 ± 0.00 |
| AI Orchestration | 4.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 |
| Customer Engagement | 4.27 ± 0.46 | 2.64 ± 0.50 | 1.10 ± 0.32 |

## Archetypes

### Strong FDE

Probes the brief with a clarifying question to the customer (Dana) before writing SQL, reads the docs, verifies all three reported issues with data, pushes back on the teammate (Sam) with evidence when his hint is wrong, and ships a ranked deliverable that explicitly distinguishes signal from noise.

| Trial | Session | Evaluation | Overall | Status |
|---:|---|---|---:|---|
| 1 | `41958729-844b-4290-8751-d49d9307491f` | `edfe7c89-834a-4213-9249-0f978b30bac7` | 4.51 | complete |
| 2 | `08a4d4b8-514c-40ae-af0f-16e3ee12db46` | `a389f589-90de-4bdb-86dc-d7c08711729a` | 4.51 | complete |
| 3 | `77a359be-7886-4821-af6d-34d0c7ed6fc4` | `d9480369-b719-41be-a5ea-ac2df79a9a11` | 4.51 | complete |
| 4 | `8b203843-1b8a-4c1c-ad15-6807569cce08` | `c092234d-7f52-4d28-aecb-71d1007f3f99` | 4.76 | complete |
| 5 | `b7cbd70c-f02f-433c-b93e-ee1032103301` | `ab0d5bf1-b309-467d-a47a-576b7b43391b` | 4.58 | complete |
| 6 | `2bd2f91a-eade-424f-8d15-507bedff81f7` | `8daddf3b-9bfa-4ed7-b96b-ff8ad8cce11f` | 4.80 | complete |
| 7 | `44759efa-8141-4d25-b0f0-762325fb9a1d` | `fc47019d-f7d1-4544-b7af-d943e3d5f726` | 4.88 | complete |
| 8 | `8bcff8f1-aa8a-421b-a780-56e0f50801df` | `8867592f-8f58-4e20-9b29-5e82af9fa138` | 4.92 | complete |
| 9 | `6642f623-761d-4c47-b8c6-9be25b33591a` | `9423546e-15b2-4b00-8b69-33e09d7501a0` | 4.76 | complete |
| 10 | `e701bb88-c27b-4d89-a335-f8859baba5b0` | `7fe5fe75-2252-49ca-a6d9-98b12c0b9892` | 4.62 | complete |
| 11 | `b0fe6bc3-2d3e-4327-ba20-f861537174c0` | `687a7b07-ef24-4afd-9df5-1c52ca222899` | 4.51 | complete |
| 12 | `355452a4-de4b-4bf1-8435-12349d9bbaa4` | `20d990ca-9f61-4540-8d46-6e19466904e3` | 4.76 | complete |
| 13 | `fff94e82-d877-4b17-be02-a2a6ce99959e` | `f7e7bb2c-9ce3-4df8-9be3-8df18694b019` | 4.76 | complete |
| 14 | `1f2cb208-6f5d-4273-9d29-1d770becf1cb` | `f2480563-1274-4b63-a143-c60b221d16d5` | 4.92 | complete |
| 15 | `c90ed496-ea6e-410a-b210-b3f42413ea4f` | `4fdd16ad-a8fd-4d85-8576-46f98bfa59a5` | 4.76 | complete |

### Median FDE

Competent SQL but does not probe ambiguity. Acknowledges the teammate neutrally without verifying his hint. Finds the two real issues (revenue + churn) but does not investigate the third. Ships a workable two-issue deliverable with a caveat about the unverified third.

| Trial | Session | Evaluation | Overall | Status |
|---:|---|---|---:|---|
| 1 | `b477b115-4a94-44e9-8363-1d97829b01a3` | `2132f32a-3b4e-457f-9c11-f92268294dbb` | 2.66 | complete |
| 2 | `f6f6b565-c092-4278-b38e-939ddfaa474f` | `5ccf6eba-1c6f-4f53-a26d-e76bcb1dd72d` | 2.54 | complete |
| 3 | `8b4f1da2-c4ba-4a2d-95d2-5174e5841a13` | `53bc51fc-64ea-4537-9f02-54e66a4e0bd9` | 2.62 | complete |
| 4 | `5ca2aa27-f179-4672-9241-bad2fac1e686` | `fbd33281-35e9-4489-ba6e-e5ff62f90090` | 2.50 | complete |
| 5 | `55c5832f-72cf-4e69-9deb-efccf9e738c7` | `f11dc5fa-53b3-4d1f-90a4-5c915d713798` | 2.66 | complete |
| 6 | `e22990a3-c9f2-488f-b8ec-5ab86c78d74e` | `f248e9f5-c70b-4174-8f73-82c01d6837a6` | 2.66 | complete |
| 7 | `15bc3cfd-274e-42ed-a69c-02a2d9bd2b78` | `a99766a9-6d74-4171-81b6-68c97562cb93` | 2.66 | complete |
| 8 | `fd9b13ba-ae60-444c-a54d-931862357585` | `951e99fd-dd74-4a6f-bec4-c3457cd42bdf` | 2.66 | complete |
| 9 | `d3d359ca-b934-4399-8313-366ccca2fef4` | `a91f973e-93ac-46bd-bffa-4c0f306a1c34` | 2.38 | complete |
| 10 | `d8340af1-a8d2-4c21-8b75-7fb35342e5d2` | `7536c961-9e77-45f8-be30-06658171d069` | 2.66 | complete |
| 11 | `28ef2366-9f7b-494d-8dfe-9143cd8dfffd` | `c17dc4c2-223e-4a15-9c9a-eedcfa94e166` | 2.50 | complete |
| 12 | `bcaaaa13-daf1-4feb-a262-6d0c59d88e58` | `f0abdd09-906b-474a-bd98-e8bf81a15469` | 2.66 | complete |
| 13 | `0bcfff7f-49dc-4fe4-aa8c-50643dbcd9bc` | `5bb4a582-86ae-4d16-9e8a-7c492e79447c` | 2.50 | complete |
| 14 | `213a36fb-75bc-4070-8844-bfe52b9e483a` | — | — | missing |
| 15 | `4b3a771f-553d-4560-970a-83f1cb31c03d` | `899a42f0-83ad-4cb4-8287-86cf066f7f79` | 2.66 | complete |

### Weak FDE

Accepts the teammate's misleading hint without verification. Runs one naive aggregate query. Does not read docs, does not ask the customer anything, does not engage the AI assistant. Submits an incomplete deliverable that prioritizes the wrong issue.

| Trial | Session | Evaluation | Overall | Status |
|---:|---|---|---:|---|
| 1 | `5361e52d-51ba-4ae2-a542-d130a70abec9` | `8532336c-65f0-432c-afc2-1907b00bbf04` | 1.00 | complete |
| 2 | `da207812-fa83-4102-a409-8208bd905df1` | `28153b38-d9bf-4606-aeb1-e14118b878f0` | 1.00 | complete |
| 3 | `25326a8e-8a41-405d-9691-63cd1c9689d9` | `caca6703-29c8-4aa7-bfe9-bc2d3a3933f6` | 1.00 | complete |
| 4 | `5137203e-8697-4ce0-87f2-ac4e4bc070ec` | `3f2f3825-2cc2-4269-94d8-c0311d1a7734` | 1.22 | complete |
| 5 | `6774f31f-1cc2-412b-950b-62648e2ff9c5` | `5e3fff07-e990-4ce6-8cdd-fc6a92b789c3` | 1.00 | complete |
| 6 | `798cd120-d701-43ba-9889-d33917ad5290` | `f1c415db-08f2-4426-bb43-1356bac92f4b` | 1.00 | complete |
| 7 | `817436a9-9076-4f05-a44f-f0ea67f58b50` | `ef2a7ed7-fb7f-4014-90ca-15bc5b0193ee` | 1.00 | complete |
| 8 | `2589f784-ac4d-4cf5-af5d-7402850edc53` | — | — | missing |
| 9 | `81762334-81fe-4dbe-b93b-092287f17a70` | `5b9e8c3b-9cb2-4d2c-9d37-be11df3dd2e0` | 1.00 | complete |
| 10 | `fe885ac1-e60e-4222-9fa7-fbcdccdeeca8` | `0ca64d46-1dca-45ca-81d6-72c17de151ab` | 1.00 | complete |
| 11 | `c1be0176-a025-45df-9f26-2197be0a4f72` | `7e3b4a2c-8ead-4c03-9cae-da65bdeb0c69` | 1.00 | complete |
| 12 | `` | — | — | error |
| 13 | `` | — | — | error |
| 14 | `dccb4fe6-0398-43ad-892c-5f3ca57e8285` | — | — | missing |
| 15 | `` | — | — | error |

## Methodology

Each trial is a real end-to-end session: HTTP-driven candidate, real E2B sandbox, real LiteLLM-gated calls to the persona agents, real Analysis Agent grading from the persisted event stream. No mocks. The three archetype playbooks are scripted sequences of (a) Dana/Sam chat turns, (b) SQL queries, (c) doc views, (d) AI assistant turns, and (e) a deliverable submission. Each archetype's playbook is identical across its 15 trials — *only the LLMs vary between trials*. Curveball timing is compressed to keep wall-clock manageable; this does not affect the rubric anchors.

## Limitations

- **N=15 per archetype** is a preliminary signal, not a significance test. A follow-up at N≥10 with confidence intervals is the next step.
- **Single scenario.** Cross-scenario validity (does the rubric generalize beyond DB triage?) is not demonstrated here; it requires running the same archetypes against at least two additional calibrated FDE scenarios.
- **Scripted playbooks** are stand-ins for real human candidate variance. They capture archetypal behavior but not the full naturalistic distribution.
- **No blind human comparison yet.** Pairing this against human rater scores on the same sessions would strengthen the validity claim.

---

Reproduce: `pnpm --filter @crucible/server exec tsx scripts/sim-fde-discrimination.ts`
