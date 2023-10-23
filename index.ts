import '@logseq/libs'
import { LSPluginBaseInfo } from '@logseq/libs/dist/libs'
import { format } from 'date-fns'
import { generatePrivateKey, getPublicKey, nip19, relayInit, nip04 } from 'nostr-tools'
import { NAV_BAR_ICON, PLUGIN_NAMESPACE, RELAY_LIST, UUID_SEED } from './constants'
import { v5 as uuidv5 } from 'uuid'

const delay = (t = 100) => new Promise(r => setTimeout(r, t))
let config;

async function getJournalPage(unixtime: number) {
  const journalName = format(new Date(unixtime * 1000), config.preferredDateFormat)
  let page = logseq.Editor.getPage(journalName)
  if (!page) {
    await logseq.Editor.createPage(
      journalName,
      {},
      {
        createFirstBlock: true,
        redirect: false,
        journal: true,
      }
    );
  }

  return page
}

async function syncRelay(relayUrl: string) {
  const relay = relayInit(`wss://${relayUrl}`)
  relay.on('connect', () => {
    logseq.App.showMsg(`connected to ${relay.url}`, 'success')
  })
  relay.on('error', () => {
    logseq.App.showMsg(`failed to connect to ${relay.url}`, 'warning')
  })

  await relay.connect()

  delay(3000)

  const publicKey = getPublicKey(logseq.settings?.nostrSyncPrivateKey)
  config = await logseq.App.getUserConfigs();

  let sub = relay.sub([
    {
      kinds: [4],
      '#p': [publicKey]
    },
  ])

  sub.on('event', async (event) => {
    try {
      const message = await nip04.decrypt(logseq.settings?.nostrSyncPrivateKey, event.pubkey, event.content)
      const page = await getJournalPage(event.created_at);

      if (page?.uuid) {
        const customUUID: string = uuidv5(event.id, UUID_SEED);
        const existingBlock = await logseq.Editor.getBlock(customUUID)
        if (existingBlock === null) {
          await logseq.Editor.insertBlock(page?.uuid, `${message} #${PLUGIN_NAMESPACE}`, { before: true, customUUID })
        }
      } else {
        logseq.App.showMsg('Journal not found', 'warning')
      }
    } catch (e) {
      logseq.App.showMsg(e.toString(), 'warning')
      console.error(e)
    }
  })
  sub.on('eose', () => {
    sub.unsub()
  })

  delay(10000)
}

async function setup() {
  const targetPage = await logseq.Editor.createPage(PLUGIN_NAMESPACE)
  logseq.App.pushState('page', targetPage)

  if (targetPage === null) return logseq.App.showMsg('Page error', 'warning')

  const pageBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()
  let tagetBlockUuid = pageBlocksTree[0]?.uuid

  const content = '🚀 Generating PubKey ...'

  if (tagetBlockUuid) {
    await logseq.Editor.updateBlock(tagetBlockUuid, content)
  } else {
    const newBlock = await logseq.Editor.insertBlock(targetPage.name, content, { before: true })
    tagetBlockUuid = newBlock?.uuid ?? tagetBlockUuid
  }

  const privateKey = generatePrivateKey()
  const relays = []

  while (relays.length < 3) {
    const randomPosition = Math.floor(Math.random() * RELAY_LIST.length)
    const relayUrl = RELAY_LIST[randomPosition]
    if (!relays.includes(relayUrl)) {
      relays.push(relayUrl)
    }
  }

  logseq.updateSettings({ nostrSyncPrivateKey: privateKey, nostrSyncRelays: relays })

  const publicKey = getPublicKey(privateKey)
  const nostrNpub = nip19.nprofileEncode({ pubkey: publicKey, relays })
  const nostrNsec = nip19.nsecEncode(privateKey)

  if (publicKey) {
    await logseq.Editor.updateBlock(tagetBlockUuid, 'This is the public key of your Logseq client:')
    await logseq.Editor.insertBlock(targetPage.name, nostrNpub, { before: true })
    await logseq.Editor.insertBlock(targetPage.name, 'All private messages sent to this public key will be downloaded to Logseq.', { before: true })
    await logseq.Editor.insertBlock(targetPage.name, '⚠️ This generated private key is NOT securely stored:', { before: true })
    await logseq.Editor.insertBlock(targetPage.name, nostrNsec, { before: true })
  }
}

/**
 * main entry
 * @param baseInfo
 */
function main(_baseInfo: LSPluginBaseInfo) {
  logseq.provideModel({
    async syncNostr() {
      try {
        if (logseq.settings?.nostrSyncPrivateKey) {
          logseq.App.showMsg('Connecting', 'info')
          const relays = logseq.settings?.nostrSyncRelays
          if (relays && relays.length > 0) {
            relays.forEach((name) => {
              syncRelay(name)
            })
          }
        } else {
          setup()
        }
      } catch (e) {
        logseq.App.showMsg(e.toString(), 'warning')
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
