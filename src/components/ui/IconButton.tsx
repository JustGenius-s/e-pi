import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className = "", ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={className} aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
