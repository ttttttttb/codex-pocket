package cn.codexpocket.app

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OnboardingTest {
    @get:Rule val compose=createAndroidComposeRule<MainActivity>()
    @Test fun onboardingAndManualPairingAreUsable(){compose.onNodeWithText("Codex Pocket").assertIsDisplayed();compose.onNodeWithText("扫描电脑二维码").performScrollTo().assertIsDisplayed();compose.onNodeWithText("无法扫码？粘贴配对内容").performScrollTo().performClick();compose.onNodeWithText("粘贴配对内容").assertIsDisplayed();compose.onNodeWithText("取消").performClick()}
}
