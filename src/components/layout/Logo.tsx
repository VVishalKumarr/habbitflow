import { Check } from 'lucide-react'

export function Logo({ compact = false, inverted = false }: { compact?: boolean; inverted?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`flex size-8 items-center justify-center rounded-[10px] shadow-sm ${inverted ? 'bg-white text-brand' : 'bg-brand text-white'}`}>
        <Check className="size-[18px]" strokeWidth={3} aria-hidden="true" />
      </span>
      {!compact && <span className="text-[17px] font-semibold tracking-tight">HabbitFlows</span>}
    </span>
  )
}
