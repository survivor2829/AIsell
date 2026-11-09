import { useEffect, useRef } from "react";
import { createMascotPet, type PetWork } from "./MascotPet";
import "./XiaoxiSprite.css";

// The desktop pet standing inside a page: it stays put, watches the pointer and acts out the moment.
export function MascotHello({ moment, width = 150 }: { moment: "celebrate" | "work" | "idle"; width?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const pet = createMascotPet(host.current, { walk: async () => ({ moved: 1 }), stopWalk: () => {}, say: () => {}, openMain: () => {} });
    const work: PetWork = moment === "work" ? "work" : null;
    if (work) pet.setWork(work);
    if (moment === "celebrate") pet.celebrate();
    const follow = (event: PointerEvent) => pet.cursor(event.clientX, event.clientY);
    window.addEventListener("pointermove", follow);
    return () => { window.removeEventListener("pointermove", follow); pet.destroy(); };
  }, [moment]);
  return <div className="mascot-hello" style={{ width }} aria-hidden="true"><div className="xiaoxi-pet" ref={host} /></div>;
}
