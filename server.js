import express from "express";
import cors from "cors";
import EventEmitter from "events";
import { Redis } from "ioredis";

import { Cart, SimplurConfig } from "@simplur/netlify-functions-helper";
import "dotenv/config";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = 3003;

console.log(process.env);

const redisHost =
  process.env.NODE_ENV === "production" ? "127.0.0.1" : "5.161.99.138";

const redisPort = 6379;

const stream = new EventEmitter();
const redis = new Redis(redisPort, redisHost); // 192.168.1.1:6379

SimplurConfig.initialize({
  wpUrl: process.env.WP_URL,
  fromPostcode: process.env.POST_CODE,
  nocodeApiSheetId: process.env.NOCODEAPI_SHEET_ID,
  createOrderPassword: process.env.CREATE_ORDER_PASSWORD,
  wooRestApi: {
    consumerKey: process.env.REST_API_CONSUMER_KEY,
    consumerSecret: process.env.REST_API_CONSUMER_SECRET,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
  },
  synchrony: {
    authenticationUrl: process.env.SYNCHRONY_AUTH_URL,
    enquiryUrl: process.env.SYNCHRONY_INQUIRY_URL,
    merchantID: process.env.NEXT_PUBLIC_MERCHANT_ID,
    password: process.env.MERCHANT_PASSWORD,
  },
});

app.listen(PORT, () => {
  console.log(`Events service listening at http://localhost:${PORT}`);
});

async function getCart(cartSessionId) {
  const cart = await redis.get(cartSessionId);
  if (cart) {
    return JSON.parse(cart);
  }
  return null;
}

class CartError extends Error {
  type;

  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

async function getCartItems(cartItemSessionId) {
  const cartItemJSON = await redis.get(cartItemSessionId);
  if (cartItemJSON) {
    return JSON.parse(cartItemJSON);
  }

  return [];
}

async function getCheckoutSession(sessionId) {
  const checkoutSessionId = `checkout:${sessionId}`;

  const checkoutSessionJSON = await redis.get(checkoutSessionId);
  let checkoutSession = null;
  if (checkoutSessionJSON) {
    checkoutSession = JSON.parse(checkoutSessionJSON);
  }

  const set = (payload) =>
    redis.set(checkoutSessionId, JSON.stringify(payload));

  return [checkoutSession, set];
}

async function resetShippingCharges(sessionId, cartItems) {
  const [checkoutSession, set] = await getCheckoutSession(sessionId);

  // const cartItems = await getCartItems(sessionId);

  const hasProducts =
    cartItems.filter((ci) => ci.type !== "EVENTTICKET").length > 0;
  const hasPricedClass =
    cartItems.filter((ci) => ci.type === "EVENTTICKET" && ci.price > 0).length >
    0;

  return set({
    hasProducts,
    hasPricedClass,
    ...checkoutSession,
    shippingCharges: [],
    shippingChargesTimeStamp: null,
    shippingChargeFetchSuccess: false,
  });
}

function getParsedJwt(token) {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch (error) {
    return undefined;
  }
}

function getExpiresIn(wooSessionId) {
  console.warn("getExpiresIn.wooSessionId", wooSessionId);
  const jwtPayload = getParsedJwt(wooSessionId);
  if (!jwtPayload) {
    console.warn("getExpiresIn.wooSessionId.invalid", wooSessionId);
  }

  const currentTime = Math.floor(Date.now() / 1000);
  return jwtPayload.exp - currentTime;
}

stream.on("addToCart", async function (data) {
  console.log("evenEmitter.addToCart.payload", data);

  const sessionId = data.sessionId;

  try {
    const cart = new Cart();

    const cartItemToAdd = data.cartItem;

    let cartResponse = null;
    if (cartItemToAdd.variation) {
      const addToCartVariableItem = {
        databaseId: cartItemToAdd.id,
        quantity: cartItemToAdd.quantity,
        clientMutationId: sessionId,
        paymentIntentId: data.paymentIntentId,
        wooSessionId: data.wooSessionId,
        variation: cartItemToAdd.variation,
      };

      cartResponse = await cart.addVariableProductToCart(addToCartVariableItem);
    } else {
      const addToCartItem = {
        databaseId: cartItemToAdd.id,
        quantity: cartItemToAdd.quantity,
        clientMutationId: sessionId,
        paymentIntentId: data.paymentIntentId,
        wooSessionId: data.wooSessionId,
        manufacturerCustomFields: null,
      };

      cartResponse = await cart.addSimpleProductToCart(addToCartItem);
    }

    console.log("cartResponse", cartResponse);

    if (cartResponse.wooSessionId) {
      const oldCart = await getCart(data.cartSessionId);
      console.log("oldCart", oldCart);
      if (oldCart && oldCart.version !== data.cartVersion) {
        await redis.del(data.cartSessionId);
        throw new CartError("VersionUpdate", "Cart version is changed");
      }

      const cartPayload = {
        subtotal: cartResponse.subtotal,
        totalDiscount: cartResponse.totalDiscount,
        coupons: cartResponse.appliedCoupons,
        wooSessionId: cartResponse.wooSessionId,
      };

      const newCart = {
        ...oldCart,
        ...cartPayload,
        sessionId,
        wooSessionId: data.wooSessionId,
      };

      const expiresIn = getExpiresIn(data.wooSessionId);
      await redis.set(
        data.cartSessionId,
        JSON.stringify(newCart),
        "EX",
        expiresIn,
      );

      const { cartItem } = cartResponse;

      const newCartItem = {
        cartId: cartItem.cartId,
        quantity: cartItem.quantity,
        price: cartItem.price,
        stockQuantity: cartItem.stockQuantity,
        stockStatus: cartItem.stockStatus,
        // backordersAllowed: cartItem.backordersAllowed,
        width: cartItem.width,
        height: cartItem.height,
        length: cartItem.length,
        weight: cartItem.weight,
        variation: cartItemToAdd.variation,
      };

      const cartItems = await getCartItems(data.cartItemSessionId);
      const dbId = cartItemToAdd.variation
        ? cartItemToAdd.variation.databaseId
        : cartItemToAdd.id;

      let cachedCartItem = null;
      if (data.cartItem.type === "VARIABLE") {
        cachedCartItem = cartItems.find(
          (ci) => ci.type === idType && ci.variation?.databaseId === dbId,
        );
      } else {
        cachedCartItem = cartItems.find((ci) => ci.id === dbId);
      }

      if (!cachedCartItem) {
        throw Error(`Invalid cart item ${dbId}`);
      }

      const updatedCartItem = Object.assign({}, cachedCartItem, newCartItem);

      let newCartitems = null;
      if (cartItemToAdd.type === "VARIABLE") {
        newCartitems = cartItems.filter(
          (ci) => ci.type === idType && ci.variation?.databaseId !== dbId,
        );
      } else {
        newCartitems = cartItems.filter((ci) => ci.id !== dbId);
      }

      newCartitems.push(updatedCartItem);

      await redis.set(
        data.cartItemSessionId,
        JSON.stringify(newCartitems),
        "EX",
        expiresIn,
      );

      await redis.set(
        data.cartItemCountSessionId,
        newCartitems.length,
        "EX",
        expiresIn,
      );

      await resetShippingCharges(sessionId, cartItems);

      stream.emit("channel", sessionId, {
        type: "addToCart",
        message: "Add to cart is completed successfully!",
        cartItem: {
          name: updatedCartItem.name,
        },
      });
    }
  } catch (err) {
    stream.emit("channel", sessionId, {
      type: "Error",
      message: err.message,
    });

    //TODO: Remove the product from session
  }
});

async function clearCartSessionData(
  cartSessionId,
  wooSessionId,
  cartItemSessionId,
  cartItemCountSessionId,
) {
  const expiresIn = getExpiresIn(wooSessionId);

  const cartPayload = {
    coupons: [],
    subtotal: 0,
    totalDiscount: 0,
  };

  await Promise.all([]);
  await redis.set(cartSessionId, JSON.stringify(cartPayload), "EX", expiresIn);

  await redis.del(cartItemSessionId);
  await redis.del(cartItemCountSessionId);
}

function getFormattedCoupons(appliedCoupons = []) {
  return appliedCoupons.map((c) => ({
    code: c.code,
    amount: c.discountAmount,
  }));
}

function setCartSessionData(sessionId, wooSessionId, payload) {
  const expiresIn = getExpiresIn(wooSessionId);

  return redis.set(sessionId, JSON.stringify(payload), "EX", expiresIn);
}

stream.on("clearCart", async (payload) => {
  console.log("evenEmitter.clearCart.payload", payload);
  const cart = new Cart();

  const { sessionId, wooSessionId, cartItem } = payload;

  try {
    await cart.clearCart(sessionId, wooSessionId);
  } catch (error) {
    //TODO: I must add `cartItem` to session based on error
    console.error(error);
  }
});

stream.on("removeCart", async (payload) => {
  console.log("evenEmitter.removeCart.payload", payload);

  const cart = new Cart();

  const sessionId = payload.sessionId;
  const wooSessionId = payload.wooSessionId;
  const cartIdToRemove = payload.cartItem.cartId;

  const cartSessionData = await redis.get(payload.cartSessionId);
  const cartItems = await getCartItems(payload.cartItemSessionId);

  const response = await cart.removeCartItem(
    sessionId,
    wooSessionId,
    cartSessionData.paymentIntentId,
    cartIdToRemove,
  );

  if (response) {
    if (response.clearCart) {
      await Promise.all([
        cart.clearCart(null, wooSessionId),
        await clearCartSessionData(
          payload.cartSessionId,
          wooSessionId,
          payload.cartItemSessionId,
          payload.cartItemCountSessionId,
        ),
      ]);
    } else {
      const appliedCoupons = getFormattedCoupons(response.appliedCoupons);

      await setCartSessionData(payload.cartSessionId, wooSessionId, {
        coupons: appliedCoupons,
        subtotal: response.subtotal,
        totalDiscount: response.totalDiscount,
      });
    }

    await resetShippingCharges(sessionId, cartItems);
  }
});

// function postHandler(request, response, next) {
//   console.log("Cookies: ", request.cookies);
//   const payload = request.body;
//   console.log("payload", payload);
//   stream.emit("channel", payload.sessionId, payload);
//   response.json(payload);
// }

async function addToCart(request, response, next) {
  const payload = request.body;
  console.log("addToCart.payload", payload);

  stream.emit("addToCart", payload);

  response.json({
    error: null,
    success: true,
  });
  // const cartItems = await redis.get(payload.cartItemSessionId)
}

async function removeCart(request, response, next) {
  const payload = request.body;
  console.log("removeCart.payload", payload);

  stream.emit("removeCart", payload);

  response.json({
    error: null,
    success: true,
  });
  // const cartItems = await redis.get(payload.cartItemSessionId)
}

async function clearCart(request, response, next) {
  const payload = request.body;
  console.log("clearCart.payload", payload);

  stream.emit("clearCart", payload);

  response.json({
    error: null,
    success: true,
  });
  // const cartItems = await redis.get(payload.cartItemSessionId)
}

function eventsHandler(request, response, next) {
  const headers = {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache,no-transform",
  };

  response.writeHead(200, headers);

  const encoder = new TextEncoder();
  stream.on("channel", function (event, data) {
    //res.write(JSON.stringify({ counter: data })); // NOTE: this DOES NOT work
    console.log("event", event);
    console.log("event.data", data);

    response.write(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  });

  const clientId = Date.now();

  request.on("close", () => {
    console.log(`${clientId} Connection closed`);
    response.end();
  });
}

app.get("/api/sse", eventsHandler);
// app.post("/api/sse", postHandler);
app.post("/api/addToCart", addToCart);
app.post("/api/removeCart", removeCart);
app.post("/api/clearCart", clearCart);

app.get("/api/status", function (request, response, next) {
  console.log("ready");
  response.json({
    message: "ready",
  });
});
