import { DIDCache, DIDDocument, DIDResolver, Resolver } from 'did-resolver'
import { RPCClient, RPCConnection } from 'rpc-utils'
import { createJWE, JWE, verifyJWS, resolveX25519Encrypters } from 'did-jwt'
import { encodePayload, prepareCleartext, decodeCleartext } from 'dag-jose-utils'
import {
  DagJWS,
  fromDagJWS,
  encodeBase64,
  base64urlToJSON,
  decodeBase64,
  encodeBase64Url,
  randomString,
} from './utils'

export type { DIDDocument, PublicKey } from 'did-resolver'
export type { DagJWS, JWSSignature } from './utils'
export type DIDProvider = RPCConnection
export type ResolverRegistry = Record<string, DIDResolver>

export interface AuthenticateOptions {
  provider?: DIDProvider
  aud?: string
  paths?: Array<string>
}

export interface AuthenticateParams {
  nonce: string
  aud?: string
  paths?: Array<string>
}

export interface AuthenticateResponse extends AuthenticateParams {
  did: string
  exp: number
}

export interface CreateJWSOptions {
  did?: string
  protected?: Record<string, any>
  linkedBlock?: string
}

export interface CreateJWSParams extends CreateJWSOptions {
  payload: any
}

export interface CreateJWSResult {
  jws: DagJWS
}

export interface CreateJWEParams extends CreateJWEOptions {
  cleartext: Uint8Array
  recipients: Array<string>
}

export interface CreateJWEResult {
  jwe: JWE
}

export interface VerifyJWSResult {
  kid: string
  payload?: Record<string, any>
}

export interface CreateJWEOptions {
  protectedHeader?: Record<string, any>
  aad?: Uint8Array
}

export interface DecryptJWEOptions {
  did?: string
}

export interface DecryptJWEParams extends DecryptJWEOptions {
  jwe: JWE
}

export interface DecryptJWEResult {
  cleartext: string // base64-encoded
}

export interface DagJWSResult {
  jws: DagJWS
  linkedBlock: Uint8Array
}

export interface DIDOptions {
  provider?: DIDProvider
  resolver?: Resolver | ResolverRegistry
  cache?: DIDCache
}

function isResolver(resolver: Resolver | ResolverRegistry): resolver is Resolver {
  return 'registry' in resolver && 'cache' in resolver
}

/**
 * Interact with DIDs.
 */
export class DID {
  private _client?: RPCClient
  private _id?: string
  private _resolver!: Resolver

  constructor({ provider, resolver = {}, cache }: DIDOptions = {}) {
    if (provider != null) {
      this._client = new RPCClient(provider)
    }
    this.setResolver(resolver, cache)
  }

  /**
   * Check if user is authenticated.
   */
  get authenticated(): boolean {
    return this._id != null
  }

  /**
   * Get the DID identifier of the user.
   */
  get id(): string {
    if (this._id == null) {
      throw new Error('DID is not authenticated')
    }
    return this._id
  }

  /**
   * Set the DID provider of this instance.
   * Only callable if provider not already set.
   *
   * @param provider    The DIDProvider to use
   */
  setProvider(provider: DIDProvider): void {
    if (this._client == null) {
      this._client = new RPCClient(provider)
    } else if (this._client.connection !== provider) {
      throw new Error(
        'A different provider is already set, create a new DID instance to use another provider'
      )
    }
  }

  /**
   * Clear DID provider from this instance.
   */
  clearProvider(): void {
    if (this._client !== undefined) {
      this._client = undefined
    }
  }

  /**
   * Set the DID-resolver user by this instance
   *
   * @param resolver    Either a Resolver instance or an object with specific resolvers
   * @param cache       A custom cache to use for the created resolver. Will be ignored if a Resolver instance is passed
   */
  setResolver(resolver: Resolver | ResolverRegistry, cache?: DIDCache): void {
    this._resolver = isResolver(resolver) ? resolver : new Resolver(resolver, cache)
  }

  /**
   * Authenticate the user.
   */
  async authenticate({ provider, paths, aud }: AuthenticateOptions = {}): Promise<string> {
    if (provider != null) {
      this.setProvider(provider)
    }
    if (this._client == null) {
      throw new Error('No provider available')
    }
    const nonce = randomString()
    const jws = await this._client.request<AuthenticateParams, DagJWS>('did_authenticate', {
      nonce,
      aud,
      paths,
    })
    const { kid } = await this.verifyJWS(jws)
    const payload = base64urlToJSON(jws.payload) as AuthenticateResponse
    if (!kid.includes(payload.did)) throw new Error('Invalid authencation response, kid mismatch')
    if (payload.nonce !== nonce) throw new Error('Invalid authencation response, wrong nonce')
    if (payload.aud !== aud) throw new Error('Invalid authencation response, wrong aud')
    if (payload.exp < Date.now() / 1000) throw new Error('Invalid authencation response, expired')
    this._id = payload.did
    return this._id
  }

  /**
   * Deauthenticate the user.
   */
  deauthenticate(): void {
    this.clearProvider()
    this._id = undefined
  }

  /**
   * Create a JWS encoded signature over the given payload.
   * Will be signed by the currently authenticated DID.
   *
   * @param payload             The payload to sign
   * @param options             Optional parameters
   */
  async createJWS<T = any>(payload: T, options: CreateJWSOptions = {}): Promise<DagJWS> {
    if (this._client == null) throw new Error('No provider available')
    if (this._id == null) throw new Error('DID is not authenticated')
    if (!options.did) options.did = this._id
    const { jws } = await this._client.request<CreateJWSParams, CreateJWSResult>('did_createJWS', {
      ...options,
      payload,
    })
    return jws
  }

  /**
   * Create an IPFS compatibe DagJWS encoded signature over the given payload.
   * Will be signed by the currently authenticated DID.
   *
   * @param payload             The payload to sign, may include ipld links
   * @param options             Optional parameters
   */
  async createDagJWS(
    payload: Record<string, any>,
    options: CreateJWSOptions = {}
  ): Promise<DagJWSResult> {
    const { cid, linkedBlock } = await encodePayload(payload)
    const payloadCid = encodeBase64Url(cid.bytes)
    Object.assign(options, { linkedBlock: encodeBase64(linkedBlock) })
    const jws = await this.createJWS(payloadCid, options)
    jws.link = cid
    return { jws, linkedBlock }
  }

  /**
   * Verify a JWS. Uses the 'kid' in the header as the way to resolve
   * the author public key.
   *
   * @param jws                 The JWS to verify
   * @returns                   Information about the signed JWS
   */
  async verifyJWS(jws: string | DagJWS): Promise<VerifyJWSResult> {
    if (typeof jws !== 'string') jws = fromDagJWS(jws)
    const kid = base64urlToJSON(jws.split('.')[0]).kid as string
    if (!kid) throw new Error('No "kid" found in jws')
    const { publicKey } = await this.resolve(kid)
    // verifyJWS will throw an error if the signature is invalid
    verifyJWS(jws, publicKey)
    let payload
    try {
      payload = base64urlToJSON(jws.split('.')[1])
    } catch (e) {
      // If an error is thrown it means that the payload is a CID.
    }
    // In the future, returned obj will need to contain
    // more metadata about the key that signed the jws.
    return { kid, payload }
  }

  /**
   * Create a JWE encrypted to the given recipients.
   *
   * @param cleartext           The cleartext to be encrypted
   * @param recipients          An array of DIDs
   * @param options             Optional parameters
   */
  async createJWE(
    cleartext: Uint8Array,
    recipients: Array<string>,
    options: CreateJWEOptions = {}
  ): Promise<JWE> {
    if (this._client == null) throw new Error('No provider available')

    const didDoc = await this._resolver.resolve(recipients[0])
    const recepients = []
    if (didDoc.publicKey[0].publicKeyHex) {
      recepients.push(didDoc.publicKey[0].publicKeyHex)
    }
    try {
      const { jwe } = await this._client.request<CreateJWEParams, CreateJWEResult>(
        'did_createJWE',
        {
          ...options,
          cleartext,
          recipients: recepients,
        }
      )
      return jwe
    } catch (err) {
      const encrypters = await resolveX25519Encrypters(recipients, this._resolver)
      return createJWE(cleartext, encrypters, options.protectedHeader, options.aad)
    }
  }

  /**
   * Create an IPFS compatibe DagJWE encrypted to the given recipients.
   *
   * @param cleartext           The cleartext to be encrypted, may include ipld links
   * @param recipients          An array of DIDs
   * @param options             Optional parameters
   */
  async createDagJWE(
    cleartext: Record<string, any>,
    recipients: Array<string>,
    options: CreateJWEOptions = {}
  ): Promise<JWE> {
    return this.createJWE(prepareCleartext(cleartext), recipients, options)
  }

  /**
   * Try to decrypt the given JWE with the currently authenticated user.
   *
   * @param jwe                 The JWE to decrypt
   * @param options             Optional parameters
   */
  async decryptJWE(jwe: JWE, options: DecryptJWEOptions = {}): Promise<Uint8Array> {
    if (this._client == null) throw new Error('No provider available')
    if (this._id == null) throw new Error('DID is not authenticated')
    if (!options.did) options.did = this._id
    const { cleartext } = await this._client.request<DecryptJWEParams, DecryptJWEResult>(
      'did_decryptJWE',
      { ...options, jwe }
    )
    return decodeBase64(cleartext)
  }

  /**
   * Try to decrypt the given DagJWE with the currently authenticated user.
   *
   * @param jwe                 The JWE to decrypt
   * @param options             Optional parameters
   * @returns                   An ipld object
   */
  async decryptDagJWE(jwe: JWE): Promise<Record<string, any>> {
    const bytes = await this.decryptJWE(jwe)
    return decodeCleartext(bytes)
  }

  /**
   * Resolve the DID Document of the given DID.
   *
   * @param didUrl              The DID to resolve
   */
  async resolve(didUrl: string): Promise<DIDDocument> {
    return await this._resolver.resolve(didUrl)
  }
}
