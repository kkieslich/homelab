# Custom LedFx

Home for LedFx effects, helper scripts, and presets that are authored in this repository.

The running LedFx container lives in `stacks/ledfx/`. Keep runtime LedFx state
in the ignored `stacks/ledfx/ledfx-config/` bind mount until that data is
migrated to `/persist/appdata/ledfx/`.

`config.example.json` is a captured example for migration/reference. Copy or
adapt it into the runtime bind mount on the host; do not treat the runtime
directory as source-controlled state.

Planned layout:

```text
stacks/ledfx/
├── effects/
├── presets/
└── scripts/
```
