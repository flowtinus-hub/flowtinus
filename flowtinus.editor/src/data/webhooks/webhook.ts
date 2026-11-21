import type { WebhookResponse } from '@flowtinus/core';

/*
 * A deployed flow's webhooks: an address of the server (POST /wh/{id}) other systems call to run the flow's deployed
 * version. The request's JSON body is the flow's input, its query string the Start's parameters (by name). Each one has
 * a token, shown once when made (only its hash is kept): the caller sends `Authorization: Bearer <token>`.
 */

export const WEBHOOK_RESPONSE_OPTIONS: { value: WebhookResponse; label: string; soon?: boolean }[] = [
    { value: 'async', label: 'Async (202, the run id)' },
    { value: 'wait', label: 'Wait (its result)' },
];

export type WebhookCall = { at: Date; status: number; runId?: string };

export type Webhook = {
    id: string;
    flowId: string;
    /** its address on the server: wh/{id} */
    path: string;
    name: string;
    enabled: boolean;
    response: WebhookResponse;
    /** the first characters of its token, to tell which one it is (the token itself is shown once) */
    tokenHint: string;
    last: WebhookCall | null;
    createdAt: Date;
    updatedBy: string;
    updatedByName?: string;
};

export type WebhookFields = Pick<Webhook, 'name' | 'enabled' | 'response'>;

/** the address other systems call */
export const webhookUrl = (origin: string, path: string) => `${origin.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

/** POST always (its JSON body is the input); GET too for a flow whose Start takes no input (the parameters in the query string) */
export const webhookMethods = (acceptsInput: boolean): ('GET' | 'POST')[] => (acceptsInput ? ['POST'] : ['GET', 'POST']);

/** a call to try it: curl with the token and a parameter, and an input when the flow takes one */
export const webhookCurl = (url: string, token: string, acceptsInput = true) =>
    acceptsInput
        ? `curl -X POST '${url}?since=7' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '[{"id": 1}]'`
        : `curl '${url}?since=7' \\\n  -H 'Authorization: Bearer ${token}'`;

export const NAME_MAX = 80;
