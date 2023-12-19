import express from "express";
import cors from "cors";
import EventEmitter from "events";
import { Redis } from "ioredis";
// import { Mutex } from "async-mutex";
// import RedisStore from "connect-redis";

import { Cart, SimplurConfig } from "@simplur/netlify-functions-helper";
import "dotenv/config";
// import session from "express-session";

const PORT = 3003;
const REDIS_PORT = 6379;

const app = express();

console.log(process.env);

const redisHost =
  process.env.NODE_ENV === "production" ? "127.0.0.1" : "5.161.99.138";

const stream = new EventEmitter();
const redis = new Redis(REDIS_PORT, redisHost); // 192.168.1.1:6379
// const sub = new Redis(redisPort, redisHost); // 192.168.1.1:6379
// const mutex = new Mutex(); // creates a shared mutex instance

// Initialize store.
// const redisStore = new RedisStore({
//   client: redis,
//   // prefix: "myapp:",
// });

app.use(cors());
app.use(express.json());
// app.use(
//   session({
//     secret: "session_secret____123!@simplur",
//     resave: false,
//     saveUninitialized: false,
//     store: redisStore,
//   }),
// );

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

// class CartError extends Error {
//   type;
//
//   constructor(type, message) {
//     super(message);
//     this.type = type;
//   }
// }

async function getCartItems(sessionId) {
  const cartItemJSON = await redis.get(sessionId);
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

async function resetShippingCharges(sessionId, cart) {
  const [checkoutSession, set] = await getCheckoutSession(sessionId);

  return set({
    ...checkoutSession,
    hasProducts: cart ? cart.hasProducts : false,
    hasPricedClass: cart ? cart.hasPricedClass : false,
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

function calculateTaxValue(totalDiscount, cartItems) {
  const taxPercentage = 0.0775;

  const totalTaxableValue = cartItems
    .filter((cartItem) => cartItem.type !== "EVENTTICKET")
    .reduce((totalTaxableValue, cartItem) => {
      let price = 0;
      if (cartItem.type === "BUNDLE") {
        if (cartItem.taxClass !== "ZERO_RATE") {
          price = cartItem.price;
        }
        price += cartItem.bundleItems.reduce((bundleTaxableTotal, bItem) => {
          let taxablePrice = 0;
          if (bItem.type === "VARIABLE") {
            if (bItem.taxClass !== "ZERO_RATE") {
              taxablePrice = bItem.price;
            }
          } else if (bItem.taxClass !== "ZERO_RATE") {
            taxablePrice = bItem.price;
          }

          return bundleTaxableTotal + taxablePrice;
        }, 0);
      } else if (cartItem.type === "VARIABLE") {
        if (cartItem.taxClass !== "ZERO_RATE") {
          price = cartItem.price;
        }
      } else if (cartItem.type === "SIMPLE") {
        if (cartItem.taxClass !== "ZERO_RATE") {
          price = cartItem.price;
        }
      }

      return totalTaxableValue + price * cartItem.quantity;
    }, 0);

  if (totalTaxableValue === 0) {
    return totalTaxableValue;
  }

  return (
    Math.round((totalTaxableValue - totalDiscount) * taxPercentage * 100) / 100
  );
}

async function addToCartMutation(data) {
  console.log("evenEmitter.addToCart.payload", data);

  const cart = new Cart();
  const cartItemToAdd = data.cartItem;

  const cartItemsSessionId = `cartItems:${data.clientMutationId}`;
  const cartSessionId = `cart:${data.clientMutationId}`;

  try {
    const cartItems = await getCartItems(cartItemsSessionId);

    const paymentIntentId = cartItems.length > 0 ? data.paymentIntentId : null;
    let cartResponse = null;
    if (cartItemToAdd.variation) {
      const addToCartVariableItem = {
        databaseId: cartItemToAdd.id,
        quantity: cartItemToAdd.quantity,
        clientMutationId: data.clientMutationId,
        paymentIntentId: paymentIntentId,
        wooSessionId: data.wooSessionId,
        variation: cartItemToAdd.variation,
      };

      cartResponse = await cart.addVariableProductToCart(addToCartVariableItem);
    } else {
      const addToCartItem = {
        databaseId: cartItemToAdd.id,
        quantity: cartItemToAdd.quantity,
        clientMutationId: data.clientMutationId,
        paymentIntentId: paymentIntentId,
        wooSessionId: data.wooSessionId,
        manufacturerCustomFields: null,
      };

      cartResponse = await cart.addSimpleProductToCart(addToCartItem);
    }

    console.log("cartResponse", cartResponse);

    if (cartResponse.wooSessionId) {
      // mutex.runExclusive(async () => {
      // if (oldCart && oldCart.version !== data.cartVersion) {
      //   await redis.del(data.cartSessionId);
      //   throw new CartError("VersionUpdate", "Cart version is changed");
      // }

      const { cartItem } = cartResponse;

      const newCartItem = {
        id: cartItemToAdd.id,
        cartId: cartItem.cartId,
        quantity: cartItem.quantity,
        price: cartItem.price,
        name: cartItemToAdd.name,
        slug: cartItemToAdd.slug,
        taxClass: cartItem.taxClass,
        // stockQuantity: cartItem.stockQuantity,
        // stockStatus: cartItem.stockStatus,
        backordersAllowed: cartItem.backordersAllowed,
        width: cartItem.width ? Number(cartItem.width) : 0,
        height: cartItem.height ? Number(cartItem.height) : 0,
        length: cartItem.length ? Number(cartItem.length) : 0,
        weight: cartItem.weight ? Number(cartItem.weight) : 0,
        variation: cartItemToAdd.variation,
        type: cartItemToAdd.type,
      };

      cartItems.push(newCartItem);
      const taxValue = calculateTaxValue(cartResponse.totalDiscount, cartItems);

      const hasProducts =
        cartItems.filter((ci) => ci.type !== "EVENTTICKET").length > 0;

      const hasFreeClass =
        cartItems.filter((ci) => ci.type === "EVENTTICKET" && ci.price === 0)
          .length > 0;

      const hasPricedClass =
        cartItems.filter((ci) => ci.type === "EVENTTICKET" && ci.price > 0)
          .length > 0;

      const newCart = {
        wooSessionId: cartResponse.wooSessionId,
        pi: cartResponse.pi,
        coupons: cartResponse.appliedCoupons,
        totalDiscount: cartResponse.totalDiscount,
        subtotal: cartResponse.subtotal,
        taxValue,
        hasProducts,
        hasPricedClass,
        hasFreeClass,
        // version: data.cartVersion,
      };

      // while (true) {
      //   try {
      //     await redis.watch(data.cartItemSessionId);
      //

      const expiresIn = getExpiresIn(newCart.wooSessionId);

      const results = await redis
        .multi()
        .set(cartSessionId, JSON.stringify(newCart), "EX", expiresIn)
        .set(cartItemsSessionId, JSON.stringify(cartItems), "EX", expiresIn)
        .exec();

      if (results) {
        await resetShippingCharges(data.clientMutationId, newCart);

        stream.emit("channel", data.clientMutationId, {
          type: "addToCart",
          message: `The product ${newCartItem.name} is added to cart successfully!`,
          cart: newCart,
          cartItem: newCartItem,
        });
      } else {
        console.log(
          "Transaction failed due to key modification by another client. Retrying...",
          results,
        );

        stream.emit("channel", data.clientMutationId, {
          type: "addToCart",
          message: "Add to cart failed",
          error: results,
          cartItem: {
            id: cartItemToAdd.id,
          },
        });
      }

      // const dbId = cartItemToAdd.variation
      //   ? cartItemToAdd.variation.databaseId
      //   : cartItemToAdd.id;
      //
      // let cachedCartItem = null;
      // if (data.cartItem.type === "VARIABLE") {
      //   cachedCartItem = cartItems.find(
      //     (ci) => ci.type === "VARIABLE" && ci.variation?.databaseId === dbId,
      //   );
      // } else {
      //   cachedCartItem = cartItems.find((ci) => ci.id === dbId);
      // }
      //
      // if (cachedCartItem) {
      //   console.log("cartItems", cartItems);
      //   throw Error(`Invalid cart item ${dbId}`);
      // }
      //
      //     const updatedCartItem = Object.assign(
      //       {},
      //       cachedCartItem,
      //       newCartItem,
      //     );
      //
      //     let newCartitems = null;
      //     if (cartItemToAdd.type === "VARIABLE") {
      //       newCartitems = cartItems.filter(
      //         (ci) =>
      //           ci.type === "VARIABLE" && ci.variation?.databaseId !== dbId,
      //       );
      //     } else {
      //       newCartitems = cartItems.filter((ci) => ci.id !== dbId);
      //     }
      //
      //     newCartitems.push(updatedCartItem);
      //
      //     console.log("cartItems", cartItems);
      //
      //     const hasProducts =
      //       cartItems.filter((ci) => ci.type !== "EVENTTICKET").length > 0;
      //
      //     const hasFreeClass =
      //       cartItems.filter(
      //         (ci) => ci.type === "EVENTTICKET" && ci.price === 0,
      //       ).length > 0;
      //     const hasPricedClass =
      //       cartItems.filter(
      //         (ci) => ci.type === "EVENTTICKET" && ci.price > 0,
      //       ).length > 0;
      //
      //     const expiresIn = getExpiresIn(cartResponse.wooSessionId);
      //
      //     const cartPayload = {
      //       subtotal: cartResponse.subtotal,
      //       totalDiscount: cartResponse.totalDiscount,
      //       coupons: cartResponse.appliedCoupons,
      //       wooSessionId: cartResponse.wooSessionId,
      //     };
      //
      //     const oldCart = await getCart(data.cartSessionId);
      //     const newCart = {
      //       ...oldCart,
      //       ...cartPayload,
      //       sessionId,
      //       wooSessionId: data.wooSessionId,
      //       version: data.cartVersion,
      //       hasProducts,
      //       hasPricedClass,
      //       hasFreeClass,
      //       shippingCharges: [],
      //       shippingChargesTimeStamp: null,
      //       shippingChargeFetchSuccess: false,
      //     };
      //
      //     const results = await redis
      //       .multi()
      //       .set(data.cartSessionId, JSON.stringify(newCart), "EX", expiresIn)
      //       .set(
      //         data.cartItemSessionId,
      //         JSON.stringify(newCartitems),
      //         "EX",
      //         expiresIn,
      //       )
      //       .set(
      //         data.cartItemCountSessionId,
      //         newCartitems.length,
      //         "EX",
      //         expiresIn,
      //       )
      //       .exec();
      //
      //     if (results) {
      //       console.log("Transaction was successful.", results);
      //
      //       stream.emit("channel", sessionId, {
      //         type: "addToCart",
      //         message: "Add to cart is completed successfully!",
      //         cart: newCart,
      //         cartItem: updatedCartItem,
      //       });
      //       break;
      //     } else {
      //       console.log(
      //         "Transaction failed due to key modification by another client. Retrying...",
      //       );
      //     }
      //   } catch (err) {
      //     console.error("AddToCart.Error:", err);
      //     break;
      //   } finally {
      //     await redis.unwatch();
      //   }
      // }
      // });
    }
  } catch (err) {
    //TODO: remove cart item, note: we have to remove cart item by database id
    // await removeCartItem({
    //   sessionId: data.sessionId,
    //   wooSessionId: data.wooSessionId,
    //   cartItem: data.cartItem,
    //   cartSessionId: data.cartSessionId,
    //   cartItemSessionId: data.cartItemSessionId,
    //   cartItemCountSessionId: data.cartItemCountSessionId,
    // });

    stream.emit("channel", data.clientMutationId, {
      type: "addToCart",
      message: err.message,
      error: err,
      cartItem: {
        id: cartItemToAdd.id,
      },
    });
  }
}

stream.on("addToCart", async function (data) {
  await addToCartMutation(data);
});

stream.on("removeCart", async (payload) => {
  try {
    await removeCartItemMutation(payload);
  } catch (err) {
    console.error(err);
  }
});

// async function clearCartSessionData(
//   cartSessionId,
//   wooSessionId,
//   cartItemSessionId,
//   cartItemCountSessionId,
// ) {
//   const expiresIn = getExpiresIn(wooSessionId);
//
//   const cartPayload = {
//     coupons: [],
//     subtotal: 0,
//     totalDiscount: 0,
//     at: Date.now(),
//   };
//
//   await redis.set(cartSessionId, JSON.stringify(cartPayload), "EX", expiresIn);
//
//   await redis.del(cartItemSessionId);
//   await redis.del(cartItemCountSessionId);
// }

function getFormattedCoupons(appliedCoupons = []) {
  return appliedCoupons.map((c) => ({
    code: c.code,
    amount: c.discountAmount,
  }));
}

// async function clearCart(clientMutationId, wooSessionId) {
//   const cart = new Cart();
//   await cart.clearCart(clientMutationId, wooSessionId);
//
//   const cartItemsSessionId = `cartItems:${clientMutationId}`;
//   const cartSessionId = `cart:${clientMutationId}`;
//   const results = await redis
//     .multi()
//     .del(cartSessionId)
//     .del(cartItemsSessionId)
//     .exec();
// }

// stream.on("clearCart", async (payload) => {
//   console.log("evenEmitter.clearCart.payload", payload);
//
//   const { sessionId, wooSessionId, cartItem } =
//     payload;
//
//   const oldCartJSON = await redis.get(cartSessionId);
//   console.log("clearCart.oldCartJSON", oldCartJSON);
//
//   let cartSessionData = {};
//   if (oldCartJSON) {
//     cartSessionData = JSON.parse(oldCartJSON);
//   }
//
//   try {
//     await clearCart(sessionId, wooSessionId)
//
//     const cartItemsSessionId = `cartItems:${clientMutationId}`;
//     const cartSessionId = `cart:${clientMutationId}`;
//     const results = await redis
//       .multi()
//       .del(cartSessionId)
//       .del(cartItemsSessionId)
//       .exec();
//
//     if (cartItem) {
//       stream.emit("channel", sessionId, {
//         type: "removeCart",
//         message: "The item is removed from cart successfully!",
//         cart: null,
//         cartItem: {
//           cartId: cartItem.cartId,
//         },
//       });
//     }
//   } catch (error) {
//     //TODO: I must add `cartItem` to session based on error
//     console.error(error);
//   }
// });

const removeCartItemMutation = async (payload) => {
  console.log("evenEmitter.removeCart.payload", payload);
  const cart = new Cart();

  const { clientMutationId, wooSessionId, paymentIntentId, cartItemId } =
    payload;

  const response = await cart.removeCartItem(
    clientMutationId,
    wooSessionId,
    paymentIntentId,
    cartItemId,
  );

  const cartItemsSessionId = `cartItems:${clientMutationId}`;
  const cartSessionId = `cart:${clientMutationId}`;

  if (response) {
    if (response.clearCart) {
      console.log("clearing cart, response:", response);
      cart.clearCart(null, wooSessionId);

      const results = await redis
        .multi()
        .del(cartSessionId)
        .del(cartItemsSessionId)
        .exec();

      await resetShippingCharges(clientMutationId, null);

      if (results) {
        const newCart = {
          pi: null,
          coupons: [],
          subtotal: 0,
          taxValue: 0,
          totalDiscount: 0,
          hasProducts: false,
          hasPricedClass: false,
          hasFreeClass: false,
        };
        stream.emit("channel", clientMutationId, {
          type: "removeCart",
          message: "The item is removed from cart successfully!",
          cart: newCart,
          cartItem: {
            cartId: cartItemId,
          },
        });
      }
    } else {
      const appliedCoupons = getFormattedCoupons(response.appliedCoupons);

      try {
        const [cartSessionData, cartItems] = await Promise.all([
          getCart(cartSessionId),
          getCartItems(cartItemsSessionId),
        ]);
        const cartItemsFilter = cartItems.filter(
          (ci) => ci.cartId !== cartItemId,
        );

        const taxValue = calculateTaxValue(
          response.totalDiscount,
          cartItemsFilter,
        );
        // const cartSessionData = await getCart(cartSessionId);

        const hasProducts =
          cartItemsFilter.filter((ci) => ci.type !== "EVENTTICKET").length > 0;

        const hasFreeClass =
          cartItemsFilter.filter(
            (ci) => ci.type === "EVENTTICKET" && ci.price === 0,
          ).length > 0;

        const hasPricedClass =
          cartItemsFilter.filter(
            (ci) => ci.type === "EVENTTICKET" && ci.price > 0,
          ).length > 0;

        const newCart = {
          ...cartSessionData,
          coupons: appliedCoupons,
          subtotal: response.subtotal,
          taxValue,
          totalDiscount: response.totalDiscount,
          hasProducts: hasProducts,
          hasPricedClass: hasPricedClass,
          hasFreeClass: hasFreeClass,
        };

        if (cartItemsFilter.length === 0) {
          // newCart.wooSessionId = null;
          newCart.pi = null;
        }

        const expiresIn = getExpiresIn(newCart.wooSessionId);

        const results = await redis
          .multi()
          .set(cartSessionId, JSON.stringify(newCart), "EX", expiresIn)
          .set(
            cartItemsSessionId,
            JSON.stringify(cartItemsFilter),
            "EX",
            expiresIn,
          )
          .exec();

        if (results) {
          await resetShippingCharges(clientMutationId, newCart);

          stream.emit("channel", clientMutationId, {
            type: "removeCart",
            message: "The item is removed from cart successfully!",
            cart: newCart,
            cartItem: {
              cartId: cartItemId,
            },
          });
        } else {
          console.log("Failed to remove cart item", results);
          stream.emit("channel", clientMutationId, {
            type: "Error",
            message: "Failed to remove cart item",
          });
        }
      } catch (err) {
        console.log("RemoveCart.Error:", err);
      }
    }
  }
};

// function postHandler(request, response, next) {
//   console.log("Cookies: ", request.cookies);
//   const payload = request.body;
//   console.log("payload", payload);
//   stream.emit("channel", payload.sessionId, payload);
//   response.json(payload);
// }

async function addToCartHandler(request, response, next) {
  const payload = request.body;
  console.log("addToCart.payload", payload);

  stream.emit("addToCart", payload);

  response.json({
    error: null,
    success: true,
  });
}

async function removeCartHandler(request, response, next) {
  const payload = request.body;
  console.log("removeCart.payload", payload);

  stream.emit("removeCart", payload);

  response.json({
    error: null,
    success: true,
  });
}

// async function clearCartHandler(request, response, next) {
//   const payload = request.body;
//   console.log("clearCart.payload", payload);
//
//   stream.emit("clearCart", payload);
//
//   response.json({
//     error: null,
//     success: true,
//   });
//   // const cartItems = await redis.get(payload.cartItemSessionId)
// }

function eventsHandler(request, response, next) {
  const headers = {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache,no-transform",
  };

  response.writeHead(200, headers);

  const encoder = new TextEncoder();

  function eventListener(event, data) {
    //res.write(JSON.stringify({ counter: data })); // NOTE: this DOES NOT work
    console.log("event", event);
    console.log("event.data", data);

    response.write(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  stream.on("channel", eventListener);

  // const clientId = Date.now();

  request.on("close", () => {
    console.log(`Connection closed`);
    stream.off("channel", eventListener);
    // response.end();
  });
}

app.get("/api/sse", eventsHandler);
// app.post("/api/sse", postHandler);
app.post("/api/addToCart", addToCartHandler);
app.post("/api/removeCart", removeCartHandler);
// app.post("/api/clearCart", clearCartHandler);

app.get("/api/status", function (request, response, next) {
  console.log("ready");
  response.json({
    message: "ready",
  });
});

// app.get("/api/getSessionId", function (request, response, next) {
//   console.log("request.headers", request.headers);
//   console.log("request.cookies", request.cookies);
//   const session = request.session.user;
//
//   console.log("session", session);
//   let sessionId = session ? request.sessionID : null;
//   response.json({
//     sessionId,
//   });
// });
//
// app.get("/api/setSession", function (request, response, next) {
//   request.session.user = { user: "test@yahoo.com" };
//
//   response.json({
//     sessionId: request.sessionID,
//   });
// });
