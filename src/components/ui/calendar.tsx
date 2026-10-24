"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/** shadcn-style Calendar on react-day-picker v9, light theme. */
function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      weekStartsOn={1}
      className={cn("p-1", className)}
      classNames={{
        months: "relative flex flex-col gap-4",
        month: "flex w-full flex-col gap-3",
        month_caption: "flex h-9 items-center justify-center",
        caption_label: "text-sm font-semibold text-[#20202a]",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous: "inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#6f6d78] hover:bg-[#f4f3f7] disabled:opacity-30",
        button_next: "inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#6f6d78] hover:bg-[#f4f3f7] disabled:opacity-30",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-9 text-center text-[11px] font-medium text-[#8a8894]",
        week: "mt-1 flex w-full",
        day: "h-9 w-9 p-0 text-center text-sm",
        day_button:
          "inline-flex h-9 w-9 items-center justify-center rounded-lg font-medium text-[#30303a] transition-colors hover:bg-[#f0ebff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7854f6]",
        selected: "[&>button]:bg-[#7854f6] [&>button]:!text-white [&>button]:hover:bg-[#6842eb]",
        today: "[&>button]:ring-1 [&>button]:ring-[#cfc4fb]",
        outside: "[&>button]:text-[#c4c2cc]",
        disabled: "[&>button]:pointer-events-none [&>button]:text-[#d4d2da]",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => (orientation === "left" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />),
      }}
      {...props}
    />
  );
}

export { Calendar };
