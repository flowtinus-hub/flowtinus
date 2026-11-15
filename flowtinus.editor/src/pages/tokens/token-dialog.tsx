import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { EXPIRY_OPTIONS, newTokenOf, RUN_FOR_REAL, toggled, validateNewToken, type ApiToken, type NewApiToken, type PickedItem, type ScopeInfo } from '@/data/tokens/api-token';
import type { Membership } from '@/data/workspaces/workspace';
import type { ApiResult } from '@/lib/api';
import { RunScopePicker } from './run-scope-picker';

const SELECT =
    'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30';

type Props = {
    open: boolean;
    scopes: ScopeInfo[];
    workspaces: Membership[];
    onClose: () => void;
    onCreate: (token: NewApiToken) => Promise<ApiResult<ApiToken & { token: string }>>;
};

/** A new token: its name, scopes, run for real (any flow, or some folders and flows) and how long it lasts; then its value, once. */
export function TokenDialog({ open, scopes, workspaces, onClose, onCreate }: Props) {
    const [created, setCreated] = useState<(ApiToken & { token: string }) | null>(null);
    const close = () => {
        setCreated(null);
        onClose();
    };
    return (
        <Dialog open={open} onOpenChange={isOpen => !isOpen && close()}>
            <DialogContent className="sm:max-w-xl">
                {created ? (
                    <TokenShown token={created} onClose={close} />
                ) : (
                    open && <TokenForm scopes={scopes} workspaces={workspaces} onCreate={onCreate} onCreated={setCreated} />
                )}
            </DialogContent>
        </Dialog>
    );
}

function TokenForm({
    scopes,
    workspaces,
    onCreate,
    onCreated,
}: Pick<Props, 'scopes' | 'workspaces' | 'onCreate'> & { onCreated: (token: ApiToken & { token: string }) => void }) {
    const [name, setName] = useState('');
    const [picked, setPicked] = useState<string[]>([]);
    const [limited, setLimited] = useState(false);
    const [items, setItems] = useState<PickedItem[]>([]);
    const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [failure, setFailure] = useState('');
    const [saving, setSaving] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const fields = { name, scopes: picked, limited, picked: items, expiresInDays };
        const found = validateNewToken(fields);
        setErrors(found);
        setFailure('');
        if (Object.keys(found).length > 0) {
            return;
        }

        setSaving(true);
        const result = await onCreate(newTokenOf(fields));
        setSaving(false);
        if (result.ok) {
            onCreated(result.value);
        } else if (result.error.fields) {
            setErrors(result.error.fields);
            setFailure(result.error.message);
        } else {
            setFailure(result.error.message);
        }
    };

    return (
        <form onSubmit={submit} noValidate className="grid gap-4">
            <DialogHeader>
                <DialogTitle>New access token</DialogTitle>
            </DialogHeader>

            <div className="grid gap-2">
                <Label htmlFor="token-name">Name</Label>
                <Input
                    id="token-name"
                    autoComplete="off"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    aria-invalid={Boolean(errors.name)}
                />
                {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
            </div>

            <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Scopes</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                    {scopes.map(({ scope, description }) => (
                        <label key={scope} className="flex items-center gap-2 text-sm" title={description}>
                            <input
                                type="checkbox"
                                className="size-4 accent-primary"
                                checked={picked.includes(scope)}
                                onChange={() => setPicked(current => toggled(current, scope))}
                            />
                            <span className="font-mono text-xs">{scope}</span>
                        </label>
                    ))}
                </div>
                {errors.scopes && <p className="text-sm text-destructive">{errors.scopes}</p>}
            </fieldset>

            {picked.includes(RUN_FOR_REAL) && (
                <fieldset className="grid gap-2">
                    <legend className="mb-2 text-sm font-medium">Run for real</legend>
                    <RadioGroup
                        value={limited ? 'some' : 'any'}
                        onValueChange={value => setLimited(value === 'some')}
                        className="grid gap-1.5"
                    >
                        <label className="flex items-center gap-2 text-sm">
                            <RadioGroupItem value="any" id="run-any" /> Any flow, with approval
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <RadioGroupItem value="some" id="run-some" /> Only these folders and flows
                        </label>
                    </RadioGroup>
                    {limited && <RunScopePicker workspaces={workspaces} picked={items} onChange={setItems} />}
                    {errors.runScope && <p className="text-sm text-destructive">{errors.runScope}</p>}
                </fieldset>
            )}

            <div className="grid gap-2">
                <Label htmlFor="token-expires">Expires</Label>
                <select
                    id="token-expires"
                    className={SELECT}
                    value={expiresInDays ?? ''}
                    onChange={event => setExpiresInDays(event.target.value ? Number(event.target.value) : null)}
                >
                    {EXPIRY_OPTIONS.map(option => (
                        <option key={option.label} value={option.days ?? ''}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>

            {failure && <p className="text-sm text-destructive">{failure}</p>}

            <DialogFooter>
                <DialogClose asChild>
                    <Button type="button" variant="outline">
                        Cancel
                    </Button>
                </DialogClose>
                <Button type="submit" disabled={saving}>
                    {saving ? 'Creating...' : 'Create token'}
                </Button>
            </DialogFooter>
        </form>
    );
}

/** the token's value, shown this once, to copy */
export function TokenShown({ token, onClose }: { token: ApiToken & { token: string }; onClose: () => void }) {
    return (
        <div className="grid gap-4">
            <DialogHeader>
                <DialogTitle>{token.name}</DialogTitle>
            </DialogHeader>
            <TokenValue token={token.token} />
            <DialogFooter>
                <Button onClick={onClose}>Done</Button>
            </DialogFooter>
        </div>
    );
}

/** the value, a button to copy it, and that it will not be shown again */
export function TokenValue({ token }: { token: string }) {
    return (
        <div className="grid gap-1">
            <Label>Token (shown once)</Label>
            <div className="flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/5 px-2 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{token}</span>
                <CopyButton text={token} label="Copy the token" />
            </div>
            <p role="alert" className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="size-3.5 shrink-0" /> Copy it now: it will not be shown again.
            </p>
        </div>
    );
}
