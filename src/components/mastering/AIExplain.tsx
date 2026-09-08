import { HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Small "?" icon that shows a plain-language explanation of a parameter/module.
 * Uses shadcn Tooltip (TooltipProvider is already mounted in App.tsx).
 */
const AIExplain = ({ text }: { text: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="text-muted-foreground/60 hover:text-primary transition-colors"
        aria-label="Explain this"
      >
        <HelpCircle className="w-3 h-3" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-[240px] text-[10px] leading-relaxed">
      {text}
    </TooltipContent>
  </Tooltip>
);

export default AIExplain;
