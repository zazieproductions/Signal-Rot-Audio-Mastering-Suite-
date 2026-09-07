== stereo section, neutral parameters, isolated ==
┌─────────┬──────────────┬──────┬───────┬───────┬───────┬────────┬──────┬───────┐
│ (index) │ case │ inCh │ outCh │ lufs │ tp │ corr │ lRms │ rRms │
├─────────┼──────────────┼──────┼───────┼───────┼───────┼────────┼──────┼───────┤
│ 0 │ 'mono1' │ 1 │ 2 │ -7.52 │ -4.26 │ -0.425 │ -8.5 │ -11.8 │
│ 1 │ 'mono2' │ 2 │ 2 │ -6.7 │ -6.02 │ 1 │ -9 │ -9 │
│ 2 │ 'corr' │ 2 │ 2 │ -6.7 │ -6.02 │ 1 │ -9 │ -9 │
│ 3 │ 'anti' │ 2 │ 2 │ -3.05 │ -0.64 │ -1 │ -5.4 │ -5.4 │
│ 4 │ 'mono1 (IN)' │ 1 │ 1 │ -9.71 │ -6.02 │ 1 │ -9 │ 'n/a' │
│ 5 │ 'mono2 (IN)' │ 2 │ 2 │ -6.7 │ -6.02 │ 1 │ -9 │ 'n/a' │
│ 6 │ 'corr (IN)' │ 2 │ 2 │ -6.7 │ -6.02 │ 1 │ -9 │ 'n/a' │
│ 7 │ 'anti (IN)' │ 2 │ 2 │ -6.7 │ -6.02 │ -1 │ -9 │ 'n/a' │
└─────────┴──────────────┴──────┴───────┴───────┴───────┴────────┴──────┴───────┘
params: schema defaults | section: stereo
curve writes: {"recorded":0,"flushed":0,"noop":0}

== anti-phase / in-phase impulse through the neutral stereo section: |H(f)| of side and mid ==
┌─────────┬────────────┬──────┬───────┬────────┬──────┬──────┬───────┬───────┐
│ (index) │ case │ inCh │ outCh │ lufs │ tp │ corr │ lRms │ rRms │
├─────────┼────────────┼──────┼───────┼────────┼──────┼──────┼───────┼───────┤
│ 0 │ 'imp-anti' │ 2 │ 2 │ -34.26 │ -2.7 │ -1 │ -44.3 │ -44.3 │
└─────────┴────────────┴──────┴───────┴────────┴──────┴──────┴───────┴───────┘
params: schema defaults | section: stereo
curve writes: {"recorded":0,"flushed":0,"noop":0}
┌─────────┬───────────┬──────┬───────┬────────┬────┬──────┬───────┬───────┐
│ (index) │ case │ inCh │ outCh │ lufs │ tp │ corr │ lRms │ rRms │
├─────────┼───────────┼──────┼───────┼────────┼────┼──────┼───────┼───────┤
│ 0 │ 'imp-mid' │ 2 │ 2 │ -36.68 │ 0 │ 1 │ -46.8 │ -46.8 │
└─────────┴───────────┴──────┴───────┴────────┴────┴──────┴───────┴───────┘
params: schema defaults | section: stereo
curve writes: {"recorded":0,"flushed":0,"noop":0}

SIDE path (mid = 0)
40 Hz: +0.7 dB, 80 Hz: +1.2 dB, 150 Hz: +4.0 dB, 250 Hz: +7.4 dB, 440 Hz: +3.7 dB, 1000 Hz: +1.3 dB, 2000 Hz: +2.8 dB, 4000 Hz: +7.4 dB, 6000 Hz: +4.6 dB, 10000 Hz: +1.3 dB, 14000 Hz: +0.4 dB, 18000 Hz: +0.1 dB
total impulse energy +2.47 dB (unity pass-through = 0.00)

MID path (side = 0)
40 Hz: +0.0 dB, 80 Hz: +0.0 dB, 150 Hz: +0.0 dB, 250 Hz: +0.0 dB, 440 Hz: +0.0 dB, 1000 Hz: +0.0 dB, 2000 Hz: +0.0 dB, 4000 Hz: +0.0 dB, 6000 Hz: +0.0 dB, 10000 Hz: +0.0 dB, 14000 Hz: +0.0 dB, 18000 Hz: +0.0 dB
total impulse energy +0.00 dB (unity pass-through = 0.00)
