# Reference-driven Blender work

Design → 3D supports declarative scenes and Blender Python for geometry nodes, particles, hair, simulation, materials and custom meshes. Python is available unless the user explicitly switches it off in the panel. Rendering and output export belong to the host, rather than the supplied program. A reference-matching camera is preserved for the primary render.

The agent receives current total/free system RAM, logical CPU count and the active resource budget in `design_3d` status. It should inspect attached references, establish the matching camera and silhouette, render a cheap preview and inspect it before refining surfaces and details. It must not claim a pixel-perfect match without verification.

Blender jobs run one at a time across chats, with one or two CPU threads and below-normal priority when supported. The host uses CPU rendering to avoid occupying the display GPU, caps render dimensions and samples according to available RAM, limits subdivision and checks base mesh vertex counts before export. Free memory is checked once per second; memory pressure stops the job tree and preserves the last completed output. The ten-minute timeout still applies. These controls reduce the risk of desktop stalls; they are not a hard per-process memory sandbox and cannot prevent every abrupt allocation spike.

On constrained machines the initial render ceiling is 512 pixels and 16 samples; machines with more available memory use up to 1024 pixels and 32 samples. The agent should use instances, bounded simulations and progressive detail. Repeating an expensive failed scene without reducing its cost is not an acceptable recovery.

Validation should use small unit tests and syntax checks. Do not run a render, full workspace build or parallel test suite merely to verify these settings.
