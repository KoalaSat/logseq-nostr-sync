import '@logseq/libs'
import { format } from 'date-fns'
import { generatePrivateKey, getPublicKey, nip19, relayInit, nip04, nip42, finishEvent } from 'nostr-tools'
import { NAV_BAR_ICON, PLUGIN_NAMESPACE, RELAY_LIST, UUID_SEED } from './constants'
import { v5 as uuidv5 } from 'uuid'
import { AppUserConfigs, PageEntity, SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin.user'

const delay = async (t = 100): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, t))
}
let config: AppUserConfigs

const settingsTemplate: SettingSchemaDesc[] = [
  {
    key: "nostrSyncPrivateKey",
    type: "string",
    default: "",
    title: "Your Logseq private key",
    description:
      "Should follow nsec format",
  },
  {
    key: "nostrSyncRelays",
    type: "string",
    default: '[]',
    title: "Relays",
    description: ''
  },
  {
    key: "nostrSyncAllowedPubkey",
    type: "string",
    default: '',
    title: "Allowed Pubkey",
    description: 'Will only fetch messages from this Pubkey. If left empty, will fetch from any source.'
  },
]
logseq.useSettingsSchema(settingsTemplate)

const getJournalPage = async (unixtime: number): Promise<PageEntity | null> => {
  const journalName = format(new Date(unixtime * 1000), config.preferredDateFormat)
  const page = logseq.Editor.getPage(journalName)
  if (page === null) {
    await logseq.Editor.createPage(
      journalName,
      {},
      {
        createFirstBlock: true,
        redirect: false,
        journal: true
      }
    )
  }

  return await page
}

const getDecodedSecretKey: () => Promise<string> = async () => {
  const nsecDecoded = await nip19.decode(logseq.settings?.nostrSyncPrivateKey)
  if (nsecDecoded.type === 'nsec') {
    return  nsecDecoded.data as string
  }

  return ''
}

const syncRelay = async (relayUrl: string): Promise<void> => {
  const relay = relayInit(`wss://${relayUrl}`)
  relay.on('connect', () => {
    logseq.UI.showMsg(`connected to ${relay.url}`, 'success')
  })
  relay.on('error', () => {
    logseq.UI.showMsg(`failed to connect to ${relay.url}`, 'warning')
  })

  await relay.connect()

  await delay(1000)

  const secretKey = await getDecodedSecretKey()
  const publicKey = getPublicKey(secretKey)
  config = await logseq.App.getUserConfigs()

  const pets = [publicKey]
  if (logseq.settings?.nostrSyncAllowedPubkey !== '') {
    const allowedPubKey = nip19.decode(logseq.settings?.nostrSyncAllowedPubkey)
    if (allowedPubKey.type === 'npub') {
      pets.push(allowedPubKey.data as string)
    } else if (allowedPubKey.type === 'nprofile') {
      pets.push(allowedPubKey.data.pubkey as string)
    }
  }

  relay.on('auth', (challenge) => {
    nip42.authenticate({ relay, sign: (e) => finishEvent(e, secretKey), challenge })
  })

  await delay(500)

  const sub = relay.sub([
    {
      kinds: [4],
      '#p': pets
    }
  ])

  sub.on('event', async (event) => {
    try {
      const message = await nip04.decrypt(
        await getDecodedSecretKey(),
        event.pubkey,
        event.content
      )
      const page = await getJournalPage(event.created_at)

      if (page !== null) {
        const customUUID: string = uuidv5(event.id, UUID_SEED)
        const existingBlock = await logseq.Editor.getBlock(customUUID)
        if (existingBlock === null && page.uuid !== null) {
          await logseq.Editor.insertBlock(page.uuid, `${message} #${PLUGIN_NAMESPACE}`, {
            before: true,
            customUUID
          })
        }
      } else {
        logseq.UI.showMsg('Journal not found', 'warning')
      }
    } catch (e: unknown) {
      logseq.UI.showMsg(e.toString(), 'warning')
      console.error(e)
    }
  })
  sub.on('eose', () => {
    sub.unsub()
  })

  await delay(10000)
}

const setup = async (): Promise<void> => {
  const targetPage = await logseq.Editor.createPage(PLUGIN_NAMESPACE)

  if (targetPage === null) {
    logseq.UI.showMsg('Page error', 'warning')
    return
  } else {
    logseq.App.pushState('page', targetPage)
  }

  const pageBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()
  let tagetBlockUuid = pageBlocksTree[0]?.uuid

  const content = '🚀 Generating PubKey ...'

  if (tagetBlockUuid !== undefined) {
    await logseq.Editor.updateBlock(tagetBlockUuid, content)
  } else {
    const newBlock = await logseq.Editor.insertBlock(targetPage.name, content, { before: true })
    tagetBlockUuid = newBlock?.uuid ?? tagetBlockUuid
  }

  const privateKey = generatePrivateKey()
  const relays: string[] = []

  while (relays.length < 4) {
    const randomPosition = Math.floor(Math.random() * RELAY_LIST.length)
    const relayUrl = RELAY_LIST[randomPosition]
    if (!relays.includes(relayUrl)) {
      relays.push(relayUrl)
    }
  }

  const publicKey = getPublicKey(privateKey)
  const nostrNsec = nip19.nsecEncode(privateKey)
  const nostrNpub = nip19.nprofileEncode({ pubkey: publicKey, relays })

  logseq.updateSettings({ nostrSyncPrivateKey: nostrNsec, nostrSyncRelays: JSON.stringify(relays) })

  if (publicKey !== null) {
    await logseq.Editor.updateBlock(tagetBlockUuid, 'This is the public key of your Logseq client:')
    await logseq.Editor.insertBlock(targetPage.name, nostrNpub, { before: true })
    await logseq.Editor.insertBlock(
      targetPage.name,
      'All private messages sent to this public key will be downloaded to Logseq.',
      { before: true }
    )
    await logseq.Editor.insertBlock(
      targetPage.name,
      '⚠️ This generated private key is NOT securely stored:',
      { before: true }
    )
    await logseq.Editor.insertBlock(targetPage.name, nostrNsec, { before: true })
  }
}

/**
 * main entry
 * @param baseInfo
 */
const main = (): void => {
  logseq.provideModel({
    async syncNostr () {
      try {
        if (logseq.settings?.nostrSyncPrivateKey !== '') {
          logseq.UI.showMsg('Connecting', 'info')
          const relays = JSON.parse(logseq.settings?.nostrSyncRelays)
          if (relays !== undefined && relays.length > 0) {
            relays.forEach((name: string) => {
              syncRelay(name).catch((e) => {
                logseq.UI.showMsg(e.toString(), 'warning')
              })
            })
          }
        } else {
          setup().catch((e) => {
            logseq.UI.showMsg(e.toString(), 'warning')
          })
        }
      } catch (e: unknown) {
        logseq.UI.showMsg(e.toString(), 'warning')
        console.error(e)
      }
    }
  })

  logseq.App.registerUIItem('toolbar', {
    key: 'logseq-nostr',
    template: NAV_BAR_ICON
  })
}

// bootstrap
logseq.ready(main).catch(console.error)
