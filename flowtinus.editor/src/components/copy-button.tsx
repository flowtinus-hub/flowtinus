import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** copies the text; a check for a moment says it did (a token shown once, an address) */
export function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            onClick={() => {
                void navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }}
        >
            {copied ? <Check /> : <Copy />}
        </Button>
    );
}
