# Modules and provider setup

The platform has five live verification modules and four reviewed-evidence modules. Live modules can also be exercised with reviewed JSON. Each rule exposes an example payload and each supported live module exposes a configuration template. Save a draft, preview with representative evidence, publish a version, run a baseline, and review coverage before enabling a workspace schedule. Findings never modify source records.

| Capability | Working input | Result |
| --- | --- | --- |
| Ticket reconciliation | ServiceNow incidents and Jira Cloud issues, or reviewed incident and issue evidence | Missing handoffs, duplicate Jira issue IDs, status drift, and unmapped values |
| Change evidence | GitHub deployments and ServiceNow change requests, or reviewed deployment and approval evidence | Missing, late, or unlinked approvals for successful deployments |
| Offboarding | ServiceNow closed catalog tasks and Entra user state, or reviewed offboarding evidence | Account or selected application access remaining after the approved due date |
| Cloud and CMDB | AWS EC2 inventory and a scoped ServiceNow CI class, or reviewed asset and CI evidence | Missing, duplicate, inactive, and conflicting inventory records |
| SLA intervention | ServiceNow Task SLA records or reviewed deadline evidence | Active cases with approaching or exceeded planned deadlines |
| MSP service reporting | Customer-scoped incidents and SLA evidence | Ticket counts, breach rate, average resolution minutes, and customer sign-off evidence |
| Vendor SLA claims | Reviewed contract terms with page references and measured incident data | Per-incident calculation, cap, claim amount, deadline and reviewed claim package |
| Upgrade readiness | ATF results and ownership or reviewer decisions | Workflow-level open issues and release readiness |
| Knowledge effectiveness | Before and after volumes, publication date and article evidence | Repeat requests per 100 requests, change, and sample-size context |

## ServiceNow and Jira

Create a dedicated ServiceNow inbound OAuth client and approve the identity's read permissions for the exact tables and fields. Supply an incident sys_id visible to that account. In Jira, create a project-scoped integration identity, choose a text custom field carrying the ServiceNow sys_id or agreed incident number, and give the integration a sample issue that contains the correlation value. Visibility of issue-security-level records matters. Choose the status IDs, not the displayed names, when mapping Jira states.

Use the ServiceNow assignment group sys_id, the Jira numeric project ID and project key, the Jira custom field ID, and an approved ServiceNow correlation field. Set the provider window and record cap to fit the project. A complete bounded project read is required to check missing targets with this release; scopes above the configured cap degrade to unknown. Ticket exceptions require two consecutive observations after grace. Separate evidence uploads are needed for synthetic or reviewed two-observation checks. Preview is read-only and baseline runs retain an observation preview without creating live alerts.

## Additional live connectors

**GitHub.** Use a read-only token for a repository that records GitHub deployment objects and deployment status events. Populate the deployment payload with the same change ID found in the approved field of ServiceNow. Use an approved ServiceNow approval timestamp field. Evidence inputs support emergency-policy flags. The default live configuration evaluates approved change records with a timestamp.

**Entra.** Provide a dedicated application with approved read permissions for account state and the selected application role assignments. Enter a sample user object ID. Scope ServiceNow catalog tasks to a dedicated assignment group and approved identity and due date fields. Verify application consent and tenant scoping with your identity administrator. Application checks cover the configured application resource IDs and do not infer access in unconnected SaaS systems.

**AWS.** Use least-privilege access for EC2 inventory in the region. A session token is accepted for temporary credentials. Configure a customer approved ServiceNow CI class, source scope field and value, and AWS resource ID field. To compare owners, use the same ownership key representation in the EC2 tag and ServiceNow field. Monitor the credential expiry if using temporary credentials.

**SLA.** Choose one Task SLA definition and verify the account can see the planned end time and state. The check uses the computed ServiceNow deadline, plus the intervention window. Paused and closed records stay out of the intervention list.

## Reviewed inputs and reports

Open the module's rule to load a schema-valid example. Replace synthetic values with reviewed data and store the approved payload before running the rule. Use the Workspace Reports page to review results and download snapshots. The JSON result captures the evidence and decision or rollup. Customer-facing MSP distribution, contractual submission, and operational remediation are human actions in this release.

Vendor credits use integer minor currency units and reviewed per-incident thresholds, basis points, exclusions, and a contract-level cap. Supply the approved measurement under the customer's business calendar. Add clause page numbers and record URLs. The app does not extract or interpret PDF contract text automatically. Upgrade records take signed review evidence and test results through the reviewed input path. Knowledge comparisons show rate changes and low sample counts and do not establish causation.
