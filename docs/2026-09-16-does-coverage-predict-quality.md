# Does the coverage score predict reconstruction quality?

**Answered 2026-09-16.** `TODO.md` has asked this since before Plac Staszica. The answer is
**partly** — two of the scorer's numbers predict quality very well, and the one the UI used to
lead with predicts nothing at all.

Everything below is measured, not argued. Method: capture plans flown in simulation
(`../sim3dgs`), frames rendered in Blender from a scene whose geometry is known exactly, pushed
through the real pipeline (GLOMAP + Brush) blind, and each resulting splat graded on **31 shared
novel views** against Blender ground truth — views no plan ever flies. Then this scorer's
predictions for the same poses were correlated against those grades
(`sim3dgs/calibrate_coverage.mjs`).

## What predicts quality

| scorer output | correlation with measured retained detail |
|---|---|
| `withLowAngle` | **r = 0.979** |
| `meanSpread` | **r = 0.979** |
| `meanViews` | r = 0.919 |
| camera count | r = 0.843 |
| **`good% + flat%`** | **r = 0.000** |

`good%` **saturates**. It reads 98–100 for every plausible plan, including plans that differ by
15 points of real retained detail and including two that reconstruct into warped geometry. It
answers "is anything starved", nothing ever is, and so it cannot rank plans. The readout now
leads with low-angle coverage instead, and turns red below 60%.

Note that camera count is the *weakest* predictor that still works. "Fly more photos" is real
but inefficient — angular spread buys more per frame. Which the next section tests directly.

## Two plan shapes that do not just look worse, they break

Both registered ~100% of their frames with unremarkable PSNR, and both produced a model whose
cameras **cannot be fitted to the true poses by any similarity transform**. The scene comes back
warped, not blurry. No 2-D metric detects this; only a fit against known poses does.

| plan | failure |
|---|---|
| `capture_nadir_only` (66 frames, pure nadir grid) | 197.9 m median sim3 error, 8/66 inliers, PSNR 28.7 |
| `div_nadir64` (64 frames, 8×8 nadir grid) | 9.7 m median sim3 error, 6/64 inliers, PSNR 19.3 |
| `az4p30` (16 positions × 4 azimuths at −30°) | robust sim3 returns **scale 0.0** — degenerate |

`summary.risk` now fires on both shapes. Verified against the five plans whose outcome is known:
both catastrophic ones warn, the best one passes clean.

## The geometry that works, measured at a fixed frame count

Every cell below is **exactly 64 frames**, so positions × azimuths is conserved. This matters:
no earlier experiment controlled for frame count, so "more passes is better" could simply have
been "more frames is better".

|  | 4 azimuths | 8 azimuths | 16 azimuths |
|---|---|---|---|
| **−30°** | DEGENERATE | **57.5%** | 49.0% |
| **−45°** | 40.0% | 43.5% | — |

- **Pitch and azimuth count interact; neither is a safe standalone rule.** At 8 azimuths, −30°
  beats −45° by +14.0 points. At 4 azimuths the sign *flips*: −45° reconstructs fine while −30°
  is degenerate. The failures cluster where both are low.
- **The azimuth payoff peaks near 8 and falls.** Four positions cannot see a 200 m site however
  many directions they look — 4 × 16 fell to 49.0%.
- **Best cell measured: ~8 positions × 8 azimuths at −30°.**

## What this does NOT establish

Read the table above as the shape of a trade, not as a universal optimum.

- **One scene.** A 200 m district: 8 buildings, 41 trees in two avenues, a plaza. A city with
  deep street canyons and a construction site with cranes are different problems, and because
  two factors were found to *interact*, extrapolating across terrain types is exactly the unsafe
  move.
- **64 frames is not a real budget.** The best cell scored 57.5% against a 300-frame plan's
  73.3%. The optimum may move at a realistic frame count.
- **n = 1 per cell, no error bars.** Brush is stochastic and the noise floor was not measured
  until after these numbers were reported. Treat single-cell gaps under a few points as unproven.
- **Altitude and overlap were never varied at fixed count.** Every cell above is at 80 m.
- **The ground is dead flat.** Slope is what breaks a constant-altitude plan, and the simulated
  world has none.

## Where the shallow pass evidence comes from

`docs/capture-planning-large-area.md` recommends a shallow −20° pass at 40 m. A simulation arm
that dropped it scored **32.56 PSNR — the best of all eight arms**, which looked like a
refutation. It was not: each arm's PSNR came from its OWN held-out split, so dropping a pass also
removes the hardest views from the exam that arm then sits. On the shared novel-view set the same
arm ranks **6th of 8 at 60.0% detail against the full plan's 73.3%**. The shallow pass is worth
**13.3 points**, and self-scored PSNR is gameable by dropping views.
