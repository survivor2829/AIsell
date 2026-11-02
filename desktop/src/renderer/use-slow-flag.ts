import { useEffect, useState } from "react";

// Quick reads finish without saying anything; only a read that is really taking long gets a note.
export function useSlowFlag(busy: boolean, ms = 3000) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(timer);
  }, [busy, ms]);
  return slow;
}
