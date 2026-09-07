== delivered true peak vs declared ceiling (independent 4x/8x/16x/32x reconstruction) ==
V-hfmax-dark -14 LUFS (tgt -14) tp -1 gr -0.01/-0.04 crest 11.75 corr 0.39 ch 2 warn 1 1.9s
V-l8-rock -9.81 LUFS (tgt -8*) tp -1 gr -1.52/-5.75 crest 10.31 corr 0.11 ch 2 warn 3 3.3s
V-sat-trans -16.64 LUFS (tgt -14*) tp -1 gr -1.77/-5.57 crest 19.62 corr -0.53 ch 2 warn 3 3.0s

3/3 rendered → /tmp/qa-evidence/verify/reports.json
waveshaper curves: {"recorded":6,"flushed":3,"noop":0}

file ceiling claimed samplePk true peak @4x @8x @16x @32x verdict
V-hfmax-dark -1.0 -1.00 -2.86 -0.06 -0.06 -0.06 -0.06 +0.94 dB over ceiling; report ceilingRespected=True, trim=0
V-l8-rock -1.0 -1.00 -1.00 -0.62 -0.62 -0.62 -0.62 +0.38 dB over ceiling; report ceilingRespected=True, trim=0
V-sat-trans -1.0 -1.00 -1.00 -0.57 -0.57 -0.55 -0.55 +0.43 dB over ceiling; report ceilingRespected=True, trim=0
