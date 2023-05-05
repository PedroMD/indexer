import {
  parseTaggedUrl,
  parseTaggedIpfsHash,
  validateNetworkIdentifier,
} from '@graphprotocol/indexer-common'

import {
  MaybeTaggedIpfsHash,
  MaybeTaggedUrl,
} from 'indexer-common/src/parsers/tagged'
import countBy from 'lodash.countby'
import isEqual from 'lodash.isequal'
import { Argv } from 'yargs'

type NetworkOptions = {
  providers: Array<MaybeTaggedUrl>
  epochSubgraphs: Array<MaybeTaggedUrl>
  networkSubgraphEndpoints: Array<MaybeTaggedUrl> | undefined
  networkSubgraphDeployments: Array<MaybeTaggedIpfsHash> | undefined
  defaultProtocolNetwork: string | undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentOptions = { [key: string]: any } & Argv['argv']

export function validateNetworkOptions(argv: AgentOptions) {
  const [networkOptions, helpText] = parseNetworkOptions(argv)
  checkMixedIdentifiers(networkOptions, helpText)
  checkDuplicatedNetworkIdentifiers(networkOptions, helpText)
  checkDefaultProtocolNetwork(networkOptions)
  reassignParsedValues(argv, networkOptions)
}

function parseNetworkOptions(argv: AgentOptions): [NetworkOptions, string] {
  // Parse each option group, making a special case for the Network Subgraph options that can be
  // partially defined.
  const providers = argv.networkProvider.map(parseTaggedUrl)
  const epochSubgraphs = argv.epochSubgraphEndpoint.map(parseTaggedUrl)
  const networkSubgraphEndpoints =
    argv.networkSubgraphEndpoint?.map(parseTaggedUrl)
  const networkSubgraphDeployments =
    argv.networkSubgraphDeployment?.map(parseTaggedIpfsHash)
  const defaultProtocolNetwork = argv.defaultProtocolNetwork
    ? validateNetworkIdentifier(argv.defaultProtocolNetwork)
    : undefined

  // Check if at least one of those two options is being used
  if (!networkSubgraphEndpoints && !networkSubgraphDeployments) {
    throw new Error(
      'At least one of --network-subgraph-endpoint and --network-subgraph-deployment must be provided',
    )
  }

  // Refine which option lists to check, while formatting a string with the used ones.
  const options = {
    providers,
    epochSubgraphs,
    defaultProtocolNetwork,
    networkSubgraphEndpoints: undefined,
    networkSubgraphDeployments: undefined,
  }
  let helpText = '[--network-provider, --epoch-subgraph-endpoint'
  if (networkSubgraphEndpoints !== undefined) {
    options.networkSubgraphEndpoints = networkSubgraphEndpoints
    helpText += ', --network-subgraph-endpoint'
  }
  if (networkSubgraphDeployments !== undefined) {
    options.networkSubgraphDeployments = networkSubgraphDeployments
    helpText += ', --network-subgraph-deployment'
  }
  helpText += ']'

  return [options, helpText]
}

interface MaybeTagged {
  networkId: string | null
}

// Extracs an array of arrays from the NetworkOptions type
function getOptionGroups(options: NetworkOptions): Array<Array<MaybeTagged>> {
  function getTag(x: MaybeTagged): MaybeTagged {
    return { networkId: x.networkId }
  }

  const optionGroups: Array<Array<MaybeTagged>> = [
    options.providers,
    options.epochSubgraphs,
  ]
  if (options.networkSubgraphEndpoints) {
    optionGroups.push(options.networkSubgraphEndpoints)
  }
  if (options.networkSubgraphDeployments) {
    optionGroups.push(options.networkSubgraphDeployments)
  }
  return optionGroups.map(sublist => sublist.map(getTag))
}

// Check for consistent network identification
function checkMixedIdentifiers(options: NetworkOptions, usedOptions: string) {
  const optionGroups = getOptionGroups(options)
  const setList = optionGroups.map(subList => new Set(subList))
  const [firstSet, ...otherSets] = setList
  for (const set of otherSets) {
    if (!isEqual(set, firstSet)) {
      throw new Error(
        `Indexer-Agent was configured with mixed network identifiers for these options: ${usedOptions}. ` +
          'Ensure that every network identifier is evenly used among options.',
      )
    }
  }
}

// Check for duplicated network identification
function checkDuplicatedNetworkIdentifiers(
  options: NetworkOptions,
  usedOptions: string,
) {
  const optionGroups = getOptionGroups(options)
  for (const optionGroup of optionGroups) {
    const usedNetworks = countBy(optionGroup, option => option.networkId)
    const maxUsed = Math.max(...Object.values(usedNetworks))
    if (maxUsed > 1) {
      throw new Error(
        `Indexer-Agent was configured with duplicate network identifiers for these options: ${usedOptions}. ` +
          'Ensure that each network identifier is used at most once.',
      )
    }
  }
}

// Checks whether the --default-protocol-network parameter is set and validates its value.
function checkDefaultProtocolNetwork(options: NetworkOptions) {
  const optionGroups = getOptionGroups(options)
  const usedNetworks = new Set(
    optionGroups.flat().map(option => option.networkId),
  )

  if (options.defaultProtocolNetwork) {
    // If it's set, validates it and ensures that the specified network is in use
    if (
      !usedNetworks.has(null) && // No need to check if networks aren't identified
      !usedNetworks.has(options.defaultProtocolNetwork)
    ) {
      throw new Error(
        'Indexer-Agent was configured with a --default-protocol-network parameter different from' +
          ' the network identifiers used in the --network-provider parameter.',
      )
    }
  } else {
    // If it's not set, ensure that only one protocol network is configured
    if (usedNetworks.size > 1) {
      throw new Error(
        'Indexer-Agent was configured with a --default-protocol-network parameter different ' +
          'from the network identifiers used in the --network-provider parameter.',
      )
    }
  }
}

function reassignParsedValues(argv: AgentOptions, options: NetworkOptions) {
  argv.networkProvider = options.providers
  argv.epochSubgraphEndpoint = options.epochSubgraphs
  argv.networkSubgraphEndpoint = options.networkSubgraphEndpoints
  argv.networkSubgraphDeployment = options.networkSubgraphDeployments
}
