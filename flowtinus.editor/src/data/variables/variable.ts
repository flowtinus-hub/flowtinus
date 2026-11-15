/*
 * A workspace's variables: like environment variables, plain values the flows read as VARIABLES['name'] (secrets
 * stay SECRETS['name']). The difference from a secret: a variable's value is not sensitive, so it is shown and can
 * be edited in place. Names follow the secrets' rule (@flowtinus/core), unique among the workspace's variables.
 */

export { secretNameError as variableNameError, VARIABLE_VALUE_MAX as VALUE_MAX, variableValueError } from '@flowtinus/core';

export type Variable = {
    id: string;
    name: string;
    value: string;
    createdAt: Date;
    updatedAt: Date;
    updatedBy: string;
    /** who that is, by name (the server's users), when known */
    updatedByName?: string;
};
