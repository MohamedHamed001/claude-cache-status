# Third-party code

## prompt-cache-control

This plugin is built on **prompt-cache-control** ("Claude Cache Control") from
[davila7/claude-code-templates](https://github.com/davila7/claude-code-templates)
(`cli-tool/components/mods/observability/prompt-cache-control`), under the MIT licence:

```
MIT License

Copyright (c) 2025 Daniel (San) Ávila

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

What comes from it:

- `hooks/pcc.ts`: its `hooks/cache.ts` (the cache rules: lifetime, advice, miss causes, per-turn
  rows, countdown pop-up marks, lifetime detection), unchanged.
- `hooks/pcc.test.ts`: the tests for those rules from its `tests/cache.test.tsx`; its band tests
  are left out.
- `hooks/register.tsx`: the band and `/cache` pane design and the session, request and timer
  wiring, adapted. Changes: the band keeps what other plugins draw beneath it; the pane gains a
  history strip, today's totals and the Keep warm and Start fresh buttons; its status-line entry
  is left out.
- `hooks/band.test.tsx`: the fake engine follows its tests.

This plugin's own additions are the 5-hour-window estimate, the saved-today totals, Keep warm,
Start fresh and the history strip (`hooks/logic.ts` and the parts of `register.tsx` that use it).
