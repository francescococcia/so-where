"use client";

import { ScanFace } from "lucide-react";
import { faceChip, type FaceBlur } from "@/lib/face-blur";
import { cn } from "@/lib/utils";

/** "Faces blurred · 2" (orange) · "No faces seen" · "Face blur unavailable on this device" (neutral, never claims blur). */
export function FaceChip({ faces, className }: { faces: FaceBlur | null; className?: string }) {
  const chip = faceChip(faces);
  if (!chip) return null;
  return (
    <span role="status" className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold", chip.tone === "done" ? "bg-signal-soft text-signal-ink" : "bg-sunk text-ink-2", className)}>
      <ScanFace className="size-3" aria-hidden /> {chip.text}
    </span>
  );
}
