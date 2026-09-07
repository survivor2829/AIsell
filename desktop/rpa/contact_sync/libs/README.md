# Contact sync native runtime

These files are bundled only to make the contact-sync helper self-contained on customer Windows machines.

- `xiaoxi-contact-helper.exe` is the standalone build committed with avatar-field support in `c77394d`. Its pinned SHA256 is `cbe4e98cace5d69cc395e0af21af9bd72aa59cc2a170772ac344e169e8bd3550`. On 2026-09-07 its built-in self-check and both avatar fields were verified against a synthetic SQLite database; the release pins were synchronized without reverting that feature. This does not replace real WeChat acceptance.
- `wx_key.dll` and `xiaoxi-db-decrypt.exe` are reused from the authorized `dt-ai-helper` compatibility runtime.
- `msvcp140.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll` are the matching Microsoft Visual C++ runtime dependencies.
- `desktop/scripts/build-portable-release.cjs` pins and verifies every shipped SHA256 before packaging.

They are internal runtime dependencies, not separately installed applications or public extension APIs.

`npm run build:helper` is only for an intentional helper refresh. A refreshed binary must be re-verified, copied here, pinned in the release checks, and committed before it can enter a delivery package.
