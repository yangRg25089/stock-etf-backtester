import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const width of [320, 1440]) {
  test(`enabled condition editor uses shared dark colors at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('.strategy-card-open').first().click();
    const dialog = page.locator('.strategy-dialog');
    await dialog.locator('[data-rule-side="sell"] > .condition-heading [role="switch"]').click();
    const buy = dialog.locator('[data-rule-side="buy"] .condition-card').first();
    const tokens = await dialog.evaluate(node => {
      const style = getComputedStyle(document.documentElement);
      return { foreground: style.getPropertyValue('--app-foreground').trim(), surface: style.getPropertyValue('--app-surface').trim(), dialog: getComputedStyle(node).color };
    });
    expect(tokens.dialog).toBe('rgb(229, 234, 243)');
    await expect(buy).toHaveCSS('background-color', 'rgb(29, 34, 43)');
    const audit = await new AxeBuilder({ page }).include('.strategy-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`dark-editor-${width}.png`) });
  });
}
