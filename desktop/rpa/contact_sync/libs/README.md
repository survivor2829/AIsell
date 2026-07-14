# Contact sync native runtime

These files are bundled only to make the contact-sync helper self-contained on customer Windows machines.

- `xiaoxi-contact-helper.exe` is the approved standalone build of this repository's contact-sync helper. Its pinned SHA256 is `f9c90aec8589ac11a93db7acfbc9b3b92c0c9c2a3b9175642829fba2e0f12eeb`.
- `wx_key.dll` and `xiaoxi-db-decrypt.exe` are reused from the authorized `dt-ai-helper` compatibility runtime.
- `msvcp140.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll` are the matching Microsoft Visual C++ runtime dependencies.
- `desktop/scripts/build-portable-release.cjs` pins and verifies every shipped SHA256 before packaging.

They are internal runtime dependencies, not separately installed applications or public extension APIs.

`npm run build:helper` is only for an intentional helper refresh. A refreshed binary must be re-verified, copied here, pinned in the release checks, and committed before it can enter a delivery package.
