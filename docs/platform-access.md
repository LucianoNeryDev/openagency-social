# Platform access

What each feature needs from Meta and Google before it works for accounts
that are not the app's own developers and testers. Without it, connecting a
client's Page or channel either fails or seems to work and then refuses to
publish.

## Meta (Facebook Pages, Instagram, WhatsApp)

A Meta app in **Development** mode works only for people with a role on the
app. For clients it must be **Live**, and every permission below beyond the
basic ones needs **Advanced Access**, granted through **App Review**, which in
turn needs **Business Verification** of the business portfolio that owns the
app. Plan a week or more for both.

| Permission | Used for | Engine feature |
| --- | --- | --- |
| `pages_show_list` | Listing the Pages the person manages at connect | Connect |
| `pages_manage_posts` | Publishing to a Page (`POST /{page}/feed`, `/{page}/photos`) | Publishing |
| `pages_read_engagement`, `read_insights` | Post and Page numbers | Statistics |
| `pages_read_user_content` | Comments under the Page's posts | Comments |
| `pages_manage_engagement` | Replying to comments | Comment replies (only when replies are on) |
| `pages_messaging` | Messenger conversations and replies | Direct messages |
| `business_management` | Pages owned through a business portfolio | Connect |
| `instagram_basic` | The Instagram account linked to a Page | Connect |
| `instagram_content_publish` | Publishing to Instagram through a Page (`/{ig-user}/media`, `media_publish`) | Publishing |
| `instagram_manage_insights` | Instagram numbers | Statistics |
| `instagram_manage_comments` | Instagram comments and replies | Comments, replies |
| `instagram_manage_messages` | Instagram direct messages | Direct messages |
| `instagram_business_*` (Instagram's own login) | The same, for accounts connected with Instagram's login instead of a Page | Instagram login channels |
| `whatsapp_business_management`, `whatsapp_business_messaging` | WhatsApp numbers and messages | WhatsApp |

The default list is in `src/platforms/meta/adapter.ts` (`defaultMetaScopes`)
and its Instagram and WhatsApp counterparts; a provider app can pin fewer
(`pnpm provider-app scopes --id … --without-replies`, [deploy.md](deploy.md)), for example without
`pages_manage_engagement` until replies pass review.

### What App Review asks for

- The app's **privacy policy URL** (Portal's `/privacy`), **terms URL**
  (`/terms`) and **data deletion**: either the instructions URL (Portal's
  `/data-deletion`) or a callback.
- For each permission, a sentence on why it is needed and a **screencast**
  showing it used end to end with a real account that is not an app role:
  connecting the Page through Facebook Login for Business, choosing it, then
  scheduling a post in Portal and showing it published on the Page (and the
  same for Instagram).
- A test account or instructions for the reviewer to sign in to Portal.
- The **Login for Business configuration** (`configId` in the provider app's
  settings) must issue a *user access token* and list the same permissions.

Until Advanced Access is granted, a client's Page can be connected only if
the client is added as a tester or developer of the app, which does not
scale and is not meant for production.

## Google (YouTube)

| Scope | Used for |
| --- | --- |
| `youtube.upload` | Uploading videos |
| `youtube.readonly` | The channel, its uploads and numbers |
| `youtube.force-ssl` | Replying to comments (only when replies are on) |

A Google Cloud project whose OAuth consent screen is in **Testing** limits
sign-in to listed test users, and its **refresh tokens expire after 7 days**,
so every channel needs a new login each week. Videos uploaded through an
**unverified** project are locked to **private**. For clients: move the
consent screen to **In production** and complete **verification** for the
sensitive and restricted scopes above (privacy policy and terms on a domain
you own and have verified in Search Console, a demo video of the scopes in
use, and possibly a security assessment for restricted scopes). The engine
reads YouTube's daily quota (10,000 units by default) and pauses reads when it
runs out; ask Google for more quota before many channels are connected.

## Browser channels

TikTok, X, LinkedIn, Threads, Pinterest and Reddit are posted through their
websites by the browser runner, with no app review. They are best effort: a
site that changes its pages or asks for a new check can stop them without
notice.
