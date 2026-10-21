import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});

/**
 * Cognito post-confirmation trigger.
 *
 * Stamps `custom:org_id` and `custom:role` onto a freshly confirmed user.
 *
 * This exists because the application treats the org claim as authoritative
 * and rejects any token without it, rather than resolving the organisation
 * from the database on every request. The cost is that signup has to do
 * this job, and if it does
 * not, the user authenticates successfully and then gets 403 on every request
 * with nothing to explain why.
 *
 * Each new signup gets its own organisation. Inviting people into an existing
 * one is a separate flow that sets the attribute directly.
 */
export const handler = async (event) => {
  // Fires for both signup and forgot-password confirmations; only the former
  // needs an organisation assigned.
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  const existing = event.request?.userAttributes?.['custom:org_id'];
  if (existing) {
    // Already set — an invite flow got here first. Do not overwrite it.
    return event;
  }

  const orgId = `org_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  try {
    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        UserAttributes: [
          { Name: 'custom:org_id', Value: orgId },
          { Name: 'custom:role', Value: 'admin' },
        ],
      }),
    );
    console.log(JSON.stringify({ msg: 'assigned org', user: event.userName, orgId }));
  } catch (err) {
    // Throwing here would fail the confirmation and leave the user unable to
    // sign in at all. Logging loudly and letting confirmation succeed is the
    // lesser failure: they can sign in, will see a clear "no organization"
    // error, and an operator can repair the attribute.
    console.error('FAILED to assign org_id', {
      user: event.userName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return event;
};
