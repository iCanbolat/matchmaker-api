import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { type AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { PurchaseSubscriptionDto } from './dto/purchase-subscription.dto';
import { SubscriptionWebhookDto } from './dto/subscription-webhook.dto';
import { VerifyReceiptDto } from './dto/verify-receipt.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('plans')
  @UseGuards(JwtAuthGuard)
  getPlans(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionsService.getPlans(user.userId);
  }

  @Post('purchase')
  @UseGuards(JwtAuthGuard)
  purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PurchaseSubscriptionDto,
  ) {
    return this.subscriptionsService.purchase(user.userId, dto);
  }

  @Post('verify-receipt')
  @UseGuards(JwtAuthGuard)
  verifyReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyReceiptDto,
  ) {
    return this.subscriptionsService.verifyReceipt(user.userId, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMySubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionsService.getMySubscription(user.userId);
  }

  @Post('cancel')
  @UseGuards(JwtAuthGuard)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CancelSubscriptionDto,
  ) {
    return this.subscriptionsService.cancelSubscription(user.userId, dto);
  }

  @Post('webhook/apple')
  handleAppleWebhook(
    @Headers('x-subscriptions-webhook-secret') secret: string | undefined,
    @Body() dto: SubscriptionWebhookDto,
  ) {
    return this.subscriptionsService.handleAppleWebhook(secret, dto);
  }

  @Post('webhook/google')
  handleGoogleWebhook(
    @Headers('x-subscriptions-webhook-secret') secret: string | undefined,
    @Body() dto: SubscriptionWebhookDto,
  ) {
    return this.subscriptionsService.handleGoogleWebhook(secret, dto);
  }
}
