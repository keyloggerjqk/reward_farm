import { BrowserTaskPage } from '../../../browser/BrowserTaskPage'
import { browserTimeout } from '../../../browser/BrowserTiming'
import { ghostClick } from '../../../browser/GhostClick'
import type { Locator, Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import type { ParsedOffer } from '../../shared/parsers/RewardsPageParser'
import { BaseActivity } from '../../shared/activities/BaseActivity'
import { BrowserRewardNavigator } from '../actions/BrowserRewardNavigator'
import { browserTaskPass } from '../BrowserTaskPass'
import { activationOutcome, activationException, type ActivationOutcome } from '../../shared/ActivationOutcome'

const SIDE_PANEL_DIALOG = '[role="dialog"]:visible'
const SIDE_PANEL_ACTIVATE_LINKS =
    'a[href*="vsstreak" i], a[href*="vstooltip" i], a[data-react-aria-pressable="true"][href], a[href]'

export class VisualSearchActivation extends BaseActivity {
    private readonly navigator = new BrowserRewardNavigator(this.bot)

    async click(target: ParsedOffer): Promise<ActivationOutcome> {
        const sourcePage = this.navigator.getActivePage()
        if (!sourcePage) {
            this.bot.logger.warn(this.bot.isMobile, 'VISUAL-SEARCH-BROWSER', 'Browser page unavailable for activation')
            return activationOutcome('unconfirmed', 'activation-page-unavailable', target.offerId)
        }

        const pass = browserTaskPass.getStore()
        const passPage = pass?.surface === 'earn' && !pass.page?.isClosed() ? pass.page : undefined
        const task = passPage ? undefined : await BrowserTaskPage.createRewards(sourcePage)
        const page = passPage ?? task!.page
        try {
            await this.navigator.openEarn(page)
            let control = await this.navigator.findOfferControl(page, {
                destination: target.destination,
                offerId: target.offerId,
                title: target.title
            })
            control ??= await this.findSemanticActivationControl(page)

            if (!control) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BROWSER',
                    `No rendered visual-search activation control matched | offerId=${target.offerId}`
                )
                return activationOutcome('unconfirmed', 'activation-control-missing', target.offerId)
            }

            const opensSidePanel = await this.isSidePanelTrigger(control)
            this.bot.logger.debug(
                this.bot.isMobile,
                'VISUAL-SEARCH-BROWSER',
                `Clicking rendered activation control | offerId=${target.offerId} | opensSidePanel=${opensSidePanel}`
            )
            try {
                if (opensSidePanel) {
                    await ghostClick(page, control, browserTimeout(this.bot), this.bot.signal, { scroll: 'direct' })
                    const cta = await this.waitForSidePanelControl(page, target)
                    if (!cta) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'VISUAL-SEARCH-BROWSER',
                            `Visual Search streak side panel opened without an activation CTA | offerId=${target.offerId}`
                        )
                        return activationOutcome('unconfirmed', 'activation-control-missing', target.offerId)
                    }
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'VISUAL-SEARCH-BROWSER',
                        `Clicking side-panel activation CTA | offerId=${target.offerId}`
                    )
                    const actionPost = this.waitForServerAction(page, target.offerId)
                    const ctaClicked = await this.navigator.click(page, cta, target.offerId)
                    try {
                        await actionPost
                    } finally {
                        await ctaClicked.close()
                    }
                } else {
                    const actionPost = this.waitForServerAction(page, target.offerId)
                    const clicked = await this.navigator.click(page, control, target.offerId)
                    try {
                        await actionPost
                    } finally {
                        await clicked.close()
                    }
                }
            } catch (error) {
                return activationException(error, target.offerId, true)
            }
            return activationOutcome('unconfirmed', 'activation-not-confirmed', target.offerId, true)
        } finally {
            await task?.close()
        }
    }

    private async isSidePanelTrigger(control: Locator): Promise<boolean> {
        return control
            .evaluate(element => {
                if (element.tagName.toLowerCase() === 'a' && element.getAttribute('href')) return false
                return (
                    element.getAttribute('aria-haspopup') === 'dialog' ||
                    Boolean(element.closest('#streaks')) ||
                    /how to activate/i.test(element.textContent ?? '')
                )
            })
            .catch(() => false)
    }

    private async waitForServerAction(page: Page, offerId: string): Promise<void> {
        const timeout = browserTimeout(this.bot, 'optional')
        const response = await page
            .waitForResponse(
                candidate => {
                    const request = candidate.request()
                    if (request.method() !== 'POST') return false
                    if (!candidate.url().startsWith(URLs.rewards.origin)) return false
                    if (!request.headers()['next-action']) return false
                    const body = request.postData() ?? ''
                    return !offerId || body.toLowerCase().includes(offerId.toLowerCase())
                },
                { timeout }
            )
            .catch(() => null)
        if (response) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'VISUAL-SEARCH-BROWSER',
                `Activation server action completed | offerId=${offerId} | status=${response.status()}`
            )
        }
    }

    private async waitForSidePanelControl(page: Page, target: ParsedOffer): Promise<Locator | null> {
        const timeout = browserTimeout(this.bot)
        const dialog = page.locator(SIDE_PANEL_DIALOG).last()
        await dialog
            .locator(SIDE_PANEL_ACTIVATE_LINKS)
            .first()
            .waitFor({ state: 'visible', timeout })
            .catch(() => undefined)

        if (!(await dialog.isVisible().catch(() => false))) return null

        const byTarget = await this.navigator.findControl(
            page,
            {
                destination: target.destination,
                offerId: target.offerId,
                title: 'Activate streak'
            },
            dialog.locator('a[href], [role="link"][href]')
        )
        if (byTarget) return byTarget

        const byDestination = await this.navigator.uniqueVisible(
            dialog.locator('a[href*="vsstreak" i], a[href*="vstooltip" i], a[data-react-aria-pressable="true"][href]'),
            'visual search side-panel activation link'
        )
        if (byDestination) return byDestination

        return this.navigator.uniqueVisible(
            dialog
                .locator('a[href], button:not([slot="close"]), [role="button"]:not([slot="close"])')
                .filter({ hasText: /activate|start|enable|turn on|search now/i }),
            'visual search side-panel activation button'
        )
    }

    private async findSemanticActivationControl(page: Page): Promise<Locator | null> {
        const byStreakIcon = await this.navigator.uniqueVisible(
            page
                .locator('#streaks button, #streaks [role="button"], main button, main [role="button"]')
                .filter({ has: page.locator('img[src*="search_visual" i], img[src*="VisualSearch" i]') }),
            'visual search streak card'
        )
        if (byStreakIcon) return byStreakIcon

        const direct = await this.navigator.uniqueVisible(
            page
                .locator('a, button, [role="button"]')
                .filter({ hasText: /activate visual search|start visual search|visual search streak/i }),
            'visual search activation'
        )
        if (direct) return direct
        const cards = page
            .locator('article, li, [role="listitem"], [data-testid*="card" i], [class*="card" i]')
            .filter({ hasText: /visual search/i })
        return this.navigator.uniqueVisible(
            cards.locator('a, button, [role="button"]').filter({ hasText: /activate|start|enable|turn on/i }),
            'visual search activation'
        )
    }
}
