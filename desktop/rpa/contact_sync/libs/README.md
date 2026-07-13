# Contact sync native runtime

These files are bundled only to make the contact-sync helper self-contained on customer Windows machines.

- `wx_key.dll` and `xiaoxi-db-decrypt.exe` are reused from the authorized `dt-ai-helper` compatibility runtime.
- `msvcp140.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll` are the matching Microsoft Visual C++ runtime dependencies.
- `desktop/scripts/build-portable-release.cjs` pins and verifies every shipped SHA256 before packaging.

They are internal runtime dependencies, not separately installed applications or public extension APIs.
