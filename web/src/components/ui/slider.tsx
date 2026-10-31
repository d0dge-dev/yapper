import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

// coss ui slider (the registry T3 Code's components.json points at), trimmed to a single thumb.
function Slider({ className, ...props }: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root className={cn("data-[orientation=horizontal]:w-full", className)} data-slot="slider" {...props}>
      <SliderPrimitive.Control className="flex touch-none select-none items-center py-2.5 data-disabled:pointer-events-none data-disabled:opacity-64">
        <SliderPrimitive.Track className="relative h-1 w-full grow rounded-full bg-input" data-slot="slider-track">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" data-slot="slider-range" />
          <SliderPrimitive.Thumb
            className="block size-5 shrink-0 rounded-full border border-input bg-white shadow-sm outline-none transition-[box-shadow] has-focus-visible:ring-[3px] has-focus-visible:ring-ring/24 sm:size-4"
            data-slot="slider-thumb"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
