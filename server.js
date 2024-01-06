import express from "express";
import cors from "cors";
import EventEmitter from "events";
import { Redis } from "ioredis";
// import { isbot } from "isbot";
import NodeCache from "node-cache";

// import { LRUCache } from "lru-cache";
// import { Mutex } from "async-mutex";
// import RedisStore from "connect-redis";

import { Cart, SimplurConfig } from "@simplur/netlify-functions-helper";
import dotenv from "dotenv";

// import session from "express-session";
import pkg from "./package.json" assert { type: "json" };

const envFileName = `.env.${process.env.NODE_ENV || "development"}`;
console.log("envFileName", envFileName);
dotenv.config({ path: envFileName });

console.log(process.env);
console.log(`Running version v${pkg.version}`);

// const lruOptions = {}
// const clients = new LRUCache(options)
const nodeCache = new NodeCache();
// let clients = [];

const PORT = Number(process.env.PORT);
const REDIS_PORT = 6379;

const app = express();

const redisHost =
  process.env.NODE_ENV === "production" ? "127.0.0.1" : "5.161.99.138";

const allowOrigin =
  process.env.NODE_ENV === "production"
    ? "https://www.rockymountainsewing.com"
    : "http://localhost:3000";

const stream = new EventEmitter();
const redis = new Redis({
  port: REDIS_PORT,
  host: redisHost,
  connectTimeout: 10000,
  username: "default", // needs Redis >= 6
  password: "fNxDZQYnYqMiBxC",
}); // 192.168.1.1:6379
// const sub = new Redis(redisPort, redisHost); // 192.168.1.1:6379
// const mutex = new Mutex(); // creates a shared mutex instance

// Initialize store.
// const redisStore = new RedisStore({
//   client: redis,
//   // prefix: "myapp:",
// });

app.options(
  "*",
  cors({
    credentials: true,
  }),
); // include before other routes
app.use(
  cors({
    credentials: true,
  }),
);
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
  if (!wooSessionId) {
    return null;
  }
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
  // console.log("evenEmitter.addToCart.payload", data);

  const cart = new Cart();
  const cartItemToAdd = data.cartItem;

  const cartItemsSessionId = `cartItems:${data.clientMutationId}`;
  const cartSessionId = `cart:${data.clientMutationId}`;
  const checkoutSessionId = `checkout:${data.clientMutationId}`;

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

    recordClientAction(
      data.clientMutationId,
      "AddToCartResponse",
      cartResponse,
    );

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
      const checkout = await getCheckoutSession(data.clientMutationId);

      const newCheckout = {
        ...checkout,
        shippingCharges: [],
        shippingChargesTimeStamp: null,
        shippingChargeFetchSuccess: false,
      };

      const expiresIn = getExpiresIn(newCart.wooSessionId);
      console.log("addToCartMutation.expiresIn", expiresIn);

      const results = await redis
        .multi()
        .set(cartSessionId, JSON.stringify(newCart), "EX", expiresIn)
        .set(cartItemsSessionId, JSON.stringify(cartItems), "EX", expiresIn)
        .set(checkoutSessionId, JSON.stringify(newCheckout), "EX", expiresIn)
        .exec();

      if (results) {
        recordClientAction(data.clientMutationId, "EndAddToCart", {
          success: true,
        });

        stream.emit(data.clientMutationId, {
          type: "addToCart",
          message: `The product ${newCartItem.name} is added to cart successfully!`,
          cart: newCart,
          cartItem: newCartItem,
        });
      } else {
        recordClientAction(data.clientMutationId, "EndAddToCart", results);
        console.log(
          "Transaction failed due to key modification by another client. Retrying...",
          results,
        );

        stream.emit(data.clientMutationId, {
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
    } else {
      recordClientAction(data.clientMutationId, "EndAddToCart", cartResponse);
      stream.emit(data.clientMutationId, {
        type: "addToCart",
        message: "Add to cart failed",
        error: results,
        cartItem: {
          id: cartItemToAdd.id,
        },
      });
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

    recordClientAction(data.clientMutationId, "EndAddToCart", err);

    stream.emit(data.clientMutationId, {
      type: "addToCart",
      message: err.message,
      error: err,
      cartItem: {
        id: cartItemToAdd.id,
      },
    });
  }
}

function recordClientAction(id, type, data) {
  // const values = nodeCache.get(id);
  // if (!values) {
  //   console.log("invalid client id", id);
  //
  //   nodeCache.set(id, [
  //     {
  //       typ: type,
  //       data,
  //       at: new Date(),
  //     },
  //   ]);
  // } else {
  //   values.push({
  //     typ: type,
  //     data,
  //     at: new Date(),
  //   });
  //
  //   nodeCache.set(id, values);
  // }
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

async function removeCartItemWpgraphql(payload) {
  const cart = new Cart();
  const { clientMutationId, wooSessionId, paymentIntentId, cartItemId } =
    payload;

  try {
    const response = await cart.removeCartItem(
      clientMutationId,
      wooSessionId,
      paymentIntentId,
      cartItemId,
    );

    return {
      error: null,
      response,
    };
  } catch (error) {
    if (
      error.message &&
      error.message.indexOf("No items in cart to remove") > -1
    ) {
      return {
        error,
        response: null,
        removeSession: false,
        clearSession: true,
      };
    } else if (
      error.message &&
      error.message.indexOf("No cart item found with the key") > -1
    ) {
      return {
        error,
        response: null,
        removeSession: true,
        clearSession: false,
      };
    } else if (error.message && error.message.indexOf("Cart is empty") > -1) {
      return {
        error,
        response: null,
        removeSession: false,
        clearAll: true,
      };
    }

    return {
      error,
      response: null,
      removeSession: false,
      clearAll: false,
    };
  }
}

async function updateSession(clientMutationId, wooSessionId, cart, cartItems) {
  const cartItemsSessionId = `cartItems:${clientMutationId}`;
  const cartSessionId = `cart:${clientMutationId}`;

  const taxValue = calculateTaxValue(cart.totalDiscount, cartItems);

  const hasProducts =
    cartItems.filter((ci) => ci.type !== "EVENTTICKET").length > 0;

  const hasFreeClass =
    cartItems.filter((ci) => ci.type === "EVENTTICKET" && ci.price === 0)
      .length > 0;

  const hasPricedClass =
    cartItems.filter((ci) => ci.type === "EVENTTICKET" && ci.price > 0).length >
    0;

  const newCart = {
    ...cart,
    taxValue,
    hasProducts: hasProducts,
    hasPricedClass: hasPricedClass,
    hasFreeClass: hasFreeClass,
  };

  if (cartItems.length === 0) {
    // newCart.wooSessionId = null;
    newCart.pi = null;
  }

  const expiresIn = getExpiresIn(wooSessionId);
  let results = null;
  if (expiresIn) {
    results = await redis
      .multi()
      .set(cartSessionId, JSON.stringify(newCart), "EX", expiresIn)
      .set(cartItemsSessionId, JSON.stringify(cartItems), "EX", expiresIn)
      .exec();
  } else {
    results = await redis
      .multi()
      .set(cartSessionId, JSON.stringify(newCart))
      .set(cartItemsSessionId, JSON.stringify(cartItems))
      .exec();
  }

  return results;
}

async function removeCartItemSession(
  clientMutationId,
  wooSessionId,
  cartItemId,
  cartResponse,
) {
  try {
    const cartItemsSessionId = `cartItems:${clientMutationId}`;
    const cartSessionId = `cart:${clientMutationId}`;

    let [cartSessionData, cartItems] = await redis
      .pipeline()
      .get(cartSessionId)
      .get(cartItemsSessionId)
      .exec();

    cartSessionData = JSON.parse(cartSessionData[1]);
    cartItems = JSON.parse(cartItems[1]) || [];

    console.log("cartItems", cartItems);
    const cartItemsFilter = cartItems.filter((ci) => ci.cartId !== cartItemId);

    // console.log("cartResponse.removeCartItemSession", cartResponse);
    if (cartResponse.error) {
      if (cartResponse.clearSession || cartItemsFilter.length === 0) {
        console.log("clearCartSession");
        await clearCartSession(clientMutationId);

        // const newCart = {
        //   pi: null,
        //   coupons: [],
        //   subtotal: 0,
        //   taxValue: 0,
        //   totalDiscount: 0,
        //   hasProducts: false,
        //   hasPricedClass: false,
        //   hasFreeClass: false,
        // };
        // stream.emit(clientMutationId, {
        //   type: "removeCart",
        //   message: "The item is removed from cart successfully!",
        //   cart: newCart,
        //   cartItem: {
        //     cartId: null,
        //   },
        // });
      } else {
        console.log("clearCart");

        await clearCartSession(clientMutationId);
        // await clearCart(clientMutationId, wooSessionId);
      }
    } else {
      const appliedCoupons = getFormattedCoupons(
        cartResponse.response.appliedCoupons,
      );

      const newCart = {
        ...cartSessionData,
        coupons: appliedCoupons,
        subtotal: cartResponse.response.subtotal,
        totalDiscount: cartResponse.response.totalDiscount,
      };

      const results = await updateSession(
        clientMutationId,
        wooSessionId,
        newCart,
        cartItemsFilter,
      );

      if (results) {
        await resetShippingCharges(clientMutationId, newCart);
        stream.emit(clientMutationId, {
          type: "removeCart",
          message: "The item is removed from cart successfully!",
          cart: newCart,
          cartItem: {
            cartId: cartItemId,
          },
        });
      } else {
        console.log("Failed to remove cart item", results);
        stream.emit(clientMutationId, {
          type: "Error",
          message: "Failed to remove cart item",
        });
      }

      return results;
    }
  } catch (error) {
    console.log("Error while removing cart item session", error);
    return false;
  }
}

async function clearCartSession(clientMutationId) {
  const cartSessionId = `cart:${clientMutationId}`;
  const cartItemsSessionId = `cartItems:${clientMutationId}`;

  const [cart, cartItems] = await redis
    .multi()
    .del(cartSessionId)
    .del(cartItemsSessionId)
    .exec();

  console.log("clearCartSession", cart);
  console.log("clearCartSession", cartItems);
  if (!cart[0] && !cartItems[0]) {
    console.log("sending notification");
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
    stream.emit(clientMutationId, {
      type: "removeCart",
      message: "The item is removed from cart successfully!",
      cart: newCart,
      cartItem: {
        cartId: null,
      },
    });
  }
}

// async function clearCart(clientMutationId, wooSessionId) {
//   const cart = new Cart();
//   cart.clearCart(null, wooSessionId);
//
//   const results = await clearCartSession(clientMutationId);
//   await resetShippingCharges(clientMutationId, null);
//
//   if (results) {
//     const newCart = {
//       pi: null,
//       coupons: [],
//       subtotal: 0,
//       taxValue: 0,
//       totalDiscount: 0,
//       hasProducts: false,
//       hasPricedClass: false,
//       hasFreeClass: false,
//     };
//     stream.emit(clientMutationId, {
//       type: "removeCart",
//       message: "The item is removed from cart successfully!",
//       cart: newCart,
//       cartItem: {
//         cartId: null,
//       },
//     });
//
//     return true;
//   }
// }

const removeCartItemMutation = async (payload) => {
  console.log("evenEmitter.removeCart.payload", payload);

  const { clientMutationId, wooSessionId, cartItemId } = payload;

  const result = await removeCartItemWpgraphql(payload);
  console.log("result", result);

  if (result.error) {
    const results = await removeCartItemSession(
      clientMutationId,
      wooSessionId,
      cartItemId,
      result,
    );
    // if (result.clearSession) {
    //   await clearCartSession(clientMutationId);
    // } else {
    // }
  } else if (result.response) {
    if (result.response.clearCart) {
      await clearCartSession(clientMutationId);
      // await clearCart(clientMutationId, wooSessionId);
    } else {
      const results = await removeCartItemSession(
        clientMutationId,
        wooSessionId,
        cartItemId,
        result,
      );
    }
  }
};

async function removeCartHandler(request, response, next) {
  const payload = request.body;
  console.log("removeCart.payload", payload);

  // recordClientAction(payload.clientMutationId, "BeginRemoveCart", payload);
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

async function eventsHandler(request, response, next) {
  const origin = request.headers.origin;
  console.log("origin", origin);
  console.log("host", request.headers.host);

  const headers = {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache,no-transform",
    "Access-Control-Allow-Origin": allowOrigin,
  };

  response.writeHead(200, headers);

  const encoder = new TextEncoder();

  function eventListener(event, data) {
    console.log("event", event);
    // console.log("event.data", data);

    response.write(
      encoder.encode(
        `event: ${request.params.id}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );

    // response.flush();
  }

  const clientId = request.params.id;
  if (!nodeCache.has(clientId)) {
    nodeCache.set(clientId, {
      at: new Date(),
    });
    // clients.push(clientId);

    // stream.once(clientId, {
    //   type: "init",
    //   payload: null,
    // });
    // const payload = {
    //   isBot: isbot(request.headers),
    // };
    //
    // recordClientAction(clientId, "NewClient", payload);
    console.log("New client client id:", clientId);
  }

  // stream.off("channel", eventListener);
  stream.on(request.params.id, eventListener);

  // redis
  //   .pipeline()
  //   .get(`cart:${clientId}`)
  //   .get(`cartItems:${clientId}`)
  //   .exec(function (error, results) {
  //     console.log("results", results);
  //     const [cart, cartItems] = results;
  //     stream.emit(clientId, {
  //       type: "init",
  //       payload: { cart: cart[0], cartItems: cartItems[1] || [] },
  //     });
  //   });

  request.on("close", () => {
    console.log(`Connection closed`, clientId);
    stream.off(clientId, eventListener);
    response.end();

    nodeCache.del(clientId);
    // clients = clients.filter((c) => c.id !== clientId);
    // stream.off("channel", eventListener);
  });
}

app.get("/api/sse/:id", eventsHandler);

app.post("/api/addToCart", function (req, res) {
  const payload = req.body;
  console.log("addToCart.handler.payload", payload);

  // recordClientAction(payload.clientMutationId, "BeginAddToCart", payload);

  stream.emit("addToCart", payload);

  res.json({
    error: null,
    success: true,
  });
});

app.post("/api/removeCart", removeCartHandler);
// app.post("/api/clearCart", clearCartHandler);

app.get("/api/status", function (request, response, next) {
  // const allClient = nodeCache.keys().map((k) => {
  //   const value = nodeCache.get(k);
  //   return { id: k, actions: value };
  // });

  response.json({
    message: "ready",
    // clients: [],
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
