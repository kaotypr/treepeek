import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@renderer/lib/utils";

export type SwitchProps = SwitchPrimitive.Root.Props;

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary-strong data-[unchecked]:bg-switch-off",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-card shadow-sm ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  );
}
