import { ExternalLink } from 'lucide-react';

/** a small button beside a picker: opens what it chose (a flow, a script) in a new tab, so this flow stays as it is */
export function OpenInNewTab({ href, label }: { href: string; label: string }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={label}
            title={label}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
            <ExternalLink className="size-4" aria-hidden />
        </a>
    );
}
