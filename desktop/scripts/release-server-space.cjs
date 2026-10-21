// Keep business services writable even if retained formal releases grow.
const reserveBytes = 2 * 1024 ** 3;
const uploadCopies = 3;
function releaseSpaceCommand(uploadBytes) {
  if (!Number.isSafeInteger(uploadBytes) || uploadBytes < 0) throw Error('release_size_invalid');
  // Upload, promotion input and canonical artifact can coexist before cleanup.
  const required = reserveBytes + uploadCopies * uploadBytes;
  if (!Number.isSafeInteger(required)) throw Error('release_size_invalid');
  return `sudo -n python3 /opt/ai-maintenance/release_cleanup.py --apply --require-free-bytes ${required}`;
}
module.exports = { releaseSpaceCommand, reserveBytes, uploadCopies };
