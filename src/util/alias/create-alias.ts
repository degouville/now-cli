import { Deployment } from '../../types';
import { Output } from '../output';
import * as ERRORS from '../errors-ts';
import Client from '../client';
import createCertForAlias from '../certs/create-cert-for-alias';
import wait from '../output/wait';

export type AliasRecord = {
  uid: string;
  alias: string;
  created?: string;
  oldDeploymentId?: string;
};

export default async function createAlias(
  output: Output,
  client: Client,
  contextName: string,
  deployment: Deployment,
  alias: string,
  externalDomain: boolean
) {
  let cancelMessage = wait(`Creating alias`);
  const result = await performCreateAlias(
    client,
    contextName,
    deployment,
    alias
  );
  cancelMessage();

  if (result instanceof ERRORS.CertMissing) {
    const cert = await createCertForAlias(
      output,
      client,
      contextName,
      alias,
      !externalDomain
    );
    if (
      cert instanceof ERRORS.CantSolveChallenge ||
      cert instanceof ERRORS.DomainConfigurationError ||
      cert instanceof ERRORS.DomainPermissionDenied ||
      cert instanceof ERRORS.DomainsShouldShareRoot ||
      cert instanceof ERRORS.DomainValidationRunning ||
      cert instanceof ERRORS.TooManyCertificates ||
      cert instanceof ERRORS.TooManyRequests ||
      cert instanceof ERRORS.InvalidDomain
    ) {
      return cert;
    }

    let cancelMessage = wait(`Creating alias`);
    const secondTry = await performCreateAlias(
      client,
      contextName,
      deployment,
      alias
    );
    cancelMessage();
    return secondTry;
  }

  return result;
}

async function performCreateAlias(
  client: Client,
  contextName: string,
  deployment: Deployment,
  alias: string
) {
  try {
    return await client.fetch<AliasRecord>(
      `/now/deployments/${deployment.uid}/aliases`,
      {
        method: 'POST',
        body: { alias }
      }
    );
  } catch (error) {
    if (error.code === 'cert_missing' || error.code === 'cert_expired') {
      return new ERRORS.CertMissing(alias);
    }
    if (error.status === 409) {
      return { uid: error.uid, alias: error.alias } as AliasRecord;
    }
    if (error.code === 'deployment_not_found') {
      return new ERRORS.DeploymentNotFound({ context: contextName, id: deployment.uid });
    }
    if (error.code === 'invalid_alias') {
      return new ERRORS.InvalidAlias(alias);
    }
    if (error.status === 403) {
      if (error.code === 'alias_in_use') {
        return new ERRORS.AliasInUse(alias);
      }
      if (error.code === 'forbidden') {
        return new ERRORS.DomainPermissionDenied(alias, contextName);
      }
    }

    throw error;
  }
}
