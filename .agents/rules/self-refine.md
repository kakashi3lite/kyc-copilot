---
name: self-refine
description: Self-Refine Loop for UI Output
trigger: model_decision
---

# Self-Refine Loop for UI Output

## When to Use
Run AFTER generating any UI component or surface. Second pass that catches
what the first pass missed.

## The Loop
READ the generated UI output
↓
CRITIQUE (adversarial — find at least one flaw):

Which token discipline rule is violated?
Which of the 8 states is missing?
Which contrast pair is weak?
Which component bypasses the registry?
Which surface would render differently from this one?
↓
IF no flaws found → STOP, output is ready
IF flaws found → REFINE:
Address each flaw specifically
Re-run the relevant oracle
↓
REPEAT (max 3 iterations)

## Critique Rules
- Must name a SPECIFIC flaw. "It looks good" is not a critique.
- Must identify specific file, line, and rule violated.
- If no flaw found after genuine adversarial review, state "No flaws found."

## Verification (Oracle)
Refinement addresses every named flaw. Re-run relevant gate.

## Stopping Rule
No new flaws, or 3 iterations. Log critique/refinement pairs in `.design-loop/LOG.md`.

## Output
Report: flaws found, refinements applied, final gate result.
