import { archiveFlow } from './archive-flow';
import { cancelRun } from './cancel-run';
import { createFlow } from './create-flow';
import { createFolder } from './create-folder';
import { createProject } from './create-project';
import { createWorkspace } from './create-workspace';
import { describeComponent } from './describe-component';
import { getDeployments } from './get-deployments';
import { getFlow } from './get-flow';
import { getFlowCalls } from './get-flow-calls';
import { getFlowFormat } from './get-flow-format';
import { getProjectContents } from './get-project-contents';
import { getRun } from './get-run';
import { getRunOutput } from './get-run-output';
import { getScript } from './get-script';
import { listComponents } from './list-components';
import { listConnections } from './list-connections';
import { listProjects } from './list-projects';
import { listRuns } from './list-runs';
import { listScriptsTool } from './list-scripts';
import { listSecretNames } from './list-secret-names';
import { listVariables } from './list-variables';
import { listWorkspaces } from './list-workspaces';
import { moveFlow } from './move-flow';
import { pinFromRun } from './pin-from-run';
import { renameFlow } from './rename-flow';
import { resolveUrl } from './resolve-url';
import { runForReal } from './run-for-real';
import { saveDraft } from './save-draft';
import { saveScript } from './save-script';
import { setVariable } from './set-variable';
import { testConnection } from './test-connection';
import { testRun } from './test-run';
import { unpin } from './unpin';
import type { McpTool } from './tool';
import { validateFlow } from './validate-flow';

/** Every MCP tool, in the order a client lists them. A new tool = a file in this folder, added here. */
export const MCP_TOOLS: McpTool[] = [
    // the catalog
    listComponents,
    describeComponent,
    getFlowFormat,
    validateFlow,
    // workspaces, projects, folders, flows (read)
    listWorkspaces,
    listProjects,
    getProjectContents,
    getFlow,
    getFlowCalls,
    getDeployments,
    resolveUrl,
    // the workspace's resources (names only) and the project's scripts
    listConnections,
    testConnection,
    listVariables,
    listSecretNames,
    listScriptsTool,
    getScript,
    // writing (drafts only: nothing is deployed)
    createWorkspace,
    createProject,
    createFolder,
    createFlow,
    saveDraft,
    renameFlow,
    moveFlow,
    saveScript,
    // a workspace's variables (scope resources:write; never a secret)
    setVariable,
    // test runs (and reading any run)
    testRun,
    getRun,
    getRunOutput,
    listRuns,
    cancelRun,
    pinFromRun,
    unpin,
    // run for real (scope runs:execute; only after the user's explicit approval)
    runForReal,
    // archive a flow (scope flows:archive; only after the user's explicit approval)
    archiveFlow,
];
