export type AvailableVariable = {
    path: string;
    type: string;
    /** short sample of the value seen in the last run (never for secrets) */
    example?: string;
};
