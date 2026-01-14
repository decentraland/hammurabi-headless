import { AuthChain, Authenticator, AuthIdentity } from '@dcl/crypto'
import { flatFetch, FlatFetchInit } from '../../misc/flat-fetch'

const AUTH_CHAIN_HEADER_PREFIX = 'x-identity-auth-chain-'
const AUTH_TIMESTAMP_HEADER = 'x-identity-timestamp'
const AUTH_METADATA_HEADER = 'x-identity-metadata'

export function getAuthChainSignature(
  method: string,
  path: string,
  metadata: string,
  chainProvider: (payload: string) => AuthChain
) {
  const timestamp = Date.now()
  const payloadParts = [method.toLowerCase(), path.toLowerCase(), timestamp.toString(), metadata]
  const payloadToSign = payloadParts.join(':').toLowerCase()
  const authChain = chainProvider(payloadToSign)

  return {
    authChain,
    metadata,
    timestamp
  }
}

export function getSignedHeaders(
  method: string,
  path: string,
  metadata: Record<string, any>,
  chainProvider: (payload: string) => AuthChain
) {
  const headers: Record<string, string> = {}
  const signature = getAuthChainSignature(method, path, JSON.stringify(metadata), chainProvider)
  signature.authChain.forEach((link, index) => {
    headers[`${AUTH_CHAIN_HEADER_PREFIX}${index}`] = JSON.stringify(link)
  })

  headers[AUTH_TIMESTAMP_HEADER] = signature.timestamp.toString()
  headers[AUTH_METADATA_HEADER] = signature.metadata
  return headers
}

const MAX_METADATA_SIZE = 2000 // 2KB limit
const MAX_METADATA_KEYS = 20
const MAX_NESTING_DEPTH = 3
const MAX_KEY_LENGTH = 50
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype']

const sanitizeObject = (obj: any, currentDepth = 0): Record<string, any> | string | number | boolean | null => {
  // Check nesting depth to prevent stack overflow
  if (currentDepth > MAX_NESTING_DEPTH) {
    console.warn('Metadata exceeds maximum nesting depth, truncating')
    return {}
  }

  // Handle primitives
  if (obj === null) return null
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    return obj
  }

  // Reject functions, symbols, undefined, and other non-serializable types
  if (typeof obj !== 'object') {
    console.warn('Unsupported value type in metadata:', typeof obj)
    return null
  }

  // Handle arrays (recursively sanitize elements)
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, currentDepth + 1))
  }

  // Sanitize plain objects
  const sanitized: Record<string, any> = {}
  let keyCount = 0

  for (const key in obj) {
    // Skip dangerous keys
    if (DANGEROUS_KEYS.includes(key)) {
      console.warn('Blocked dangerous key in metadata:', key)
      continue
    }

    // Only process own properties
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue
    }

    // Enforce key limit
    if (keyCount >= MAX_METADATA_KEYS) {
      console.warn('Metadata exceeds maximum key limit, truncating')
      break
    }

    // Validate key is a string and not too long
    if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) {
      console.warn('Invalid key in metadata, skipping:', key)
      continue
    }

    // Recursively sanitize the value
    const sanitizedValue = sanitizeObject(obj[key], currentDepth + 1)
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue
      keyCount++
    }
  }

  return sanitized
}

const safeParseMetadata = (metadata: string): Record<string, any> => {
  try {
    // Check payload size before parsing
    if (metadata.length > MAX_METADATA_SIZE) {
      console.warn(`Metadata exceeds size limit (${metadata.length} > ${MAX_METADATA_SIZE}), rejecting`)
      return {}
    }

    const parsed = JSON.parse(metadata)

    // Ensure root is a plain object (not null, array, or other types)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('Invalid metadata format, expected object')
      return {}
    }

    // Recursively sanitize the entire structure
    const sanitized = sanitizeObject(parsed, 0) as Record<string, any>

    return sanitized
  } catch (error) {
    console.warn('Failed to parse metadata, using empty object:', error)
    return {}
  }
}

export function signedFetch(
  url: string,
  identity: AuthIdentity,
  init?: FlatFetchInit,
  additionalMetadata: Record<string, any> = {}
) {
  const path = new URL(url).pathname

  const { [AUTH_METADATA_HEADER]: initMetadata = '{}', ...restInitHeaders } =
    (init?.headers as Record<string, string> | undefined) ?? {}

  const actualInit = {
    ...init,
    headers: {
      ...getSignedHeaders(
        init?.method ?? 'get',
        path,
        {
          origin: 'hammurabi-server://',
          ...additionalMetadata,
          ...safeParseMetadata(initMetadata)
        },
        (payload) => Authenticator.signPayload(identity, payload)
      ),
      ...restInitHeaders
    }
  } as FlatFetchInit

  return flatFetch(url, actualInit)
}
