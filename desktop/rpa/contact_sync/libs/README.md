# Contact sync native runtime

These files are bundled only to make the contact-sync helper self-contained on customer Windows machines.

- `xiaoxi-contact-helper.exe` is the approved standalone build of this repository's contact-sync helper. Its pinned SHA256 is `d08eeaef4db75cb8943164ca78ecb84818ac8e94213f7b404e51f5eceb75d05a`.
- `wx_key.dll` and `xiaoxi-db-decrypt.exe` are reused from the authorized `dt-ai-helper` compatibility runtime.
- `msvcp140.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll` are the matching Microsoft Visual C++ runtime dependencies.
- `desktop/scripts/build-portable-release.cjs` pins and verifies every shipped SHA256 before packaging.

They are internal runtime dependencies, not separately installed applications or public extension APIs.

`npm run build:helper` is only for an intentional helper refresh. A refreshed binary must be re-verified, copied here, pinned in the release checks, and committed before it can enter a delivery package.
