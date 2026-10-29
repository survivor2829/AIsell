// 「返回上一级」= back to where the user came from (user decision 2026-10-29), not a fixed jump to
// the home page. A place is a page plus its sub-view (the workspace has several).
export type Place = { active: string; view: string };

const LIMIT = 30;
const same = (a: Place, b: Place) => a.active === b.active && a.view === b.view;

// Moving from one place to another remembers the one left behind.
export function remember(stack: Place[], from: Place, to: Place): Place[] {
  if (same(from, to)) return stack;
  const last = stack[stack.length - 1];
  return (last && same(last, from) ? stack : [...stack, from]).slice(-LIMIT);
}

// The place to return to, skipping any entry equal to where the user is now.
export function back(stack: Place[], here: Place): { place: Place | null; stack: Place[] } {
  const rest = [...stack];
  while (rest.length) {
    const place = rest.pop()!;
    if (!same(place, here)) return { place, stack: rest };
  }
  return { place: null, stack: rest };
}
